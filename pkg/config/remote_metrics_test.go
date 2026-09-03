package config

import (
	"testing"
	"time"

	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"
)

func enabledRemoteMetrics(endpoints ...RemoteMetricEndpoint) *RemoteMetricsConfig {
	return &RemoteMetricsConfig{Enabled: true, Endpoints: endpoints}
}

// TestValidateRejectsAUrlWithNoHost covers an unset substitution in the config.
// The URL stays syntactically valid and resolves to the machine running the
// benchmark, so every node would report that one machine and no scrape would
// fail. Nothing later in the run could detect it.
func TestValidateRejectsAUrlWithNoHost(t *testing.T) {
	cfg := enabledRemoteMetrics(RemoteMetricEndpoint{
		Name: "node1",
		URL:  "http://:9401/metrics",
	})

	err := cfg.Validate()
	require.Error(t, err)
	assert.Contains(t, err.Error(), "no host")
}

func TestValidateAcceptsARealEndpoint(t *testing.T) {
	cfg := enabledRemoteMetrics(
		RemoteMetricEndpoint{Name: "node1", URL: "http://10.0.0.1:9401/metrics"},
		RemoteMetricEndpoint{Name: "node2", URL: "http://10.0.0.2:9401/metrics"},
	)
	assert.NoError(t, cfg.Validate())
}

func TestValidateRejectsARepeatedName(t *testing.T) {
	cfg := enabledRemoteMetrics(
		RemoteMetricEndpoint{Name: "node1", URL: "http://10.0.0.1:9401/metrics"},
		RemoteMetricEndpoint{Name: "node1", URL: "http://10.0.0.2:9401/metrics"},
	)

	err := cfg.Validate()
	require.Error(t, err)
	assert.Contains(t, err.Error(), "used twice")
}

func TestValidateIgnoresADisabledFeature(t *testing.T) {
	cfg := &RemoteMetricsConfig{Endpoints: []RemoteMetricEndpoint{{Name: "node1", URL: "http://:9401"}}}
	assert.NoError(t, cfg.Validate(), "a switched off feature is not a configuration error")
}

// TestIntervalRejectsANonPositiveValue keeps a ticker from panicking the run.
// A zero duration parses cleanly, so only a range check catches it.
func TestIntervalRejectsANonPositiveValue(t *testing.T) {
	assert.Equal(t, DefaultRemoteMetricsInterval, (&RemoteMetricsConfig{Interval: "0s"}).GetInterval())
	assert.Equal(t, DefaultRemoteMetricsInterval, (&RemoteMetricsConfig{Interval: "-1s"}).GetInterval())
	assert.Equal(t, 50*time.Millisecond, (&RemoteMetricsConfig{Interval: "50ms"}).GetInterval())

	assert.Equal(t, DefaultRemoteMetricsTimeout, (&RemoteMetricsConfig{Timeout: "0s"}).GetTimeout())
	assert.Equal(t, 3*time.Second, (&RemoteMetricsConfig{Timeout: "3s"}).GetTimeout())
}

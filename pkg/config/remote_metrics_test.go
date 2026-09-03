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

func node(name string) map[string]string {
	return map[string]string{"node": name}
}

// TestValidateRejectsAUrlWithNoHost covers an unset substitution in the config.
// A missing host resolves to the machine running the benchmark, so every
// endpoint would report that one machine under a different node and no scrape
// would fail.
func TestValidateRejectsAUrlWithNoHost(t *testing.T) {
	cfg := enabledRemoteMetrics(RemoteMetricEndpoint{Kind: "dcgm-exporter", URL: "http://:9401/metrics", Labels: node("node1")})

	err := cfg.Validate()
	require.Error(t, err)
	assert.Contains(t, err.Error(), "no host")
}

// TestValidateAcceptsOneEndpointPerKind is the shape a node takes, one
// exposition for its GPUs and one for the machine, under the same labels.
func TestValidateAcceptsOneEndpointPerKind(t *testing.T) {
	cfg := enabledRemoteMetrics(
		RemoteMetricEndpoint{Kind: "dcgm-exporter", URL: "http://10.0.0.1:9401/metrics", Labels: node("node1")},
		RemoteMetricEndpoint{Kind: "node-exporter", URL: "http://10.0.0.1:9402/metrics", Labels: node("node1")},
		RemoteMetricEndpoint{Kind: "dcgm-exporter", URL: "http://10.0.0.2:9401/metrics", Labels: node("node2")},
	)
	assert.NoError(t, cfg.Validate())
}

// TestValidateRejectsAnUnknownKind is how a mistyped kind arrives. Nothing
// would be recorded from the endpoint, and the run would end with a warning
// and no artifact rather than an error.
func TestValidateRejectsAnUnknownKind(t *testing.T) {
	cfg := enabledRemoteMetrics(RemoteMetricEndpoint{Kind: "cadvisor", URL: "http://10.0.0.1:8080/metrics", Labels: node("node1")})

	err := cfg.Validate()
	require.Error(t, err)
	assert.Contains(t, err.Error(), "kind")
}

// TestValidateRejectsAnEndpointWithoutLabels keeps two nodes from sharing one
// device. The labels are the only thing that tells their series apart.
func TestValidateRejectsAnEndpointWithoutLabels(t *testing.T) {
	cfg := enabledRemoteMetrics(RemoteMetricEndpoint{Kind: "node-exporter", URL: "http://10.0.0.1:9402/metrics"})

	err := cfg.Validate()
	require.Error(t, err)
	assert.Contains(t, err.Error(), "labels")
}

func TestValidateRejectsARepeatedNodeAndKind(t *testing.T) {
	cfg := enabledRemoteMetrics(
		RemoteMetricEndpoint{Kind: "dcgm-exporter", URL: "http://10.0.0.1:9401/metrics", Labels: node("node1")},
		RemoteMetricEndpoint{Kind: "dcgm-exporter", URL: "http://10.0.0.2:9401/metrics", Labels: node("node1")},
	)

	err := cfg.Validate()
	require.Error(t, err)
	assert.Contains(t, err.Error(), "twice")
}

func TestValidateIgnoresADisabledFeature(t *testing.T) {
	cfg := &RemoteMetricsConfig{Endpoints: []RemoteMetricEndpoint{{URL: "http://:9401"}}}
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

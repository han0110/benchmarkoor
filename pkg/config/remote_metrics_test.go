package config

import (
	"os"
	"path/filepath"
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

// TestDeviceIDsReachTheEndpointFromTheConfigFile covers the key over the path
// a run takes, which decodes through viper rather than the yaml tags.
func TestDeviceIDsReachTheEndpointFromTheConfigFile(t *testing.T) {
	path := filepath.Join(t.TempDir(), "benchmarkoor.yaml")
	require.NoError(t, os.WriteFile(path, []byte(`runner:
  remote_metrics:
    enabled: true
    endpoints:
      - kind: dcgm-exporter
        url: http://10.0.0.1:9401/metrics
        labels: { node: node1 }
        device_ids: [0, 2]
`), 0o644))

	cfg, err := Load(path)
	require.NoError(t, err)

	endpoints := cfg.Runner.RemoteMetrics.Endpoints
	require.Len(t, endpoints, 1)
	assert.Equal(t, []int{0, 2}, endpoints[0].DeviceIDs)
	assert.NoError(t, cfg.Runner.RemoteMetrics.Validate())
}

// TestValidateRejectsDeviceIDsOnANodeEndpoint covers the key on the wrong
// kind. Only a DCGM series carries a gpu label, so the endpoint would report
// nothing at all.
func TestValidateRejectsDeviceIDsOnANodeEndpoint(t *testing.T) {
	cfg := enabledRemoteMetrics(RemoteMetricEndpoint{
		Kind: "node-exporter", URL: "http://10.0.0.1:9402/metrics", Labels: node("node1"), DeviceIDs: []int{0},
	})

	err := cfg.Validate()
	require.Error(t, err)
	assert.Contains(t, err.Error(), "endpoint 0")
	assert.Contains(t, err.Error(), "device_ids")
}

func TestValidateRejectsARepeatedDeviceID(t *testing.T) {
	cfg := enabledRemoteMetrics(RemoteMetricEndpoint{
		Kind: "dcgm-exporter", URL: "http://10.0.0.1:9401/metrics", Labels: node("node1"), DeviceIDs: []int{0, 1, 0},
	})

	err := cfg.Validate()
	require.Error(t, err)
	assert.Contains(t, err.Error(), "twice")
}

// TestValidateRejectsANegativeDeviceID covers an id no gpu label carries,
// which would drop every series of the endpoint.
func TestValidateRejectsANegativeDeviceID(t *testing.T) {
	cfg := enabledRemoteMetrics(RemoteMetricEndpoint{
		Kind: "dcgm-exporter", URL: "http://10.0.0.1:9401/metrics", Labels: node("node1"), DeviceIDs: []int{-1},
	})

	err := cfg.Validate()
	require.Error(t, err)
	assert.Contains(t, err.Error(), "endpoint 0")
	assert.Contains(t, err.Error(), "device_ids")
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

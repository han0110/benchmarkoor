package config

import (
	"fmt"
	"net/url"
	"time"

	"github.com/ethpandaops/benchmarkoor/pkg/remotemetrics"
)

// RemoteMetricsConfig scrapes Prometheus text endpoints on remote hosts and
// records a reduced window for every block a run executes.
//
// The endpoints are the sidecars provoor runs on every node. The kind of an
// endpoint selects the series recorded from it, listed in artifactColumns in
// package remotemetrics, and the artifact its devices land in.
type RemoteMetricsConfig struct {
	Enabled   bool                   `yaml:"enabled" mapstructure:"enabled"`
	Interval  string                 `yaml:"interval,omitempty" mapstructure:"interval"` // default 100ms
	Timeout   string                 `yaml:"timeout,omitempty" mapstructure:"timeout"`   // default 2s
	Endpoints []RemoteMetricEndpoint `yaml:"endpoints" mapstructure:"endpoints"`
}

// RemoteMetricEndpoint is one exposition to scrape.
//
// Kind names the exporter, dcgm-exporter or node-exporter, so one node lists
// one endpoint per kind. Labels identify the node in the results and are
// attached to every series the endpoint reports, which is how node identity
// reaches the results without the exporter having to know it. They must not
// carry a hostname, because results are published.
type RemoteMetricEndpoint struct {
	Kind   string            `yaml:"kind" mapstructure:"kind"`
	URL    string            `yaml:"url" mapstructure:"url"`
	Labels map[string]string `yaml:"labels" mapstructure:"labels"`
}

// Default values for RemoteMetricsConfig when fields are left empty.
const (
	DefaultRemoteMetricsInterval = 100 * time.Millisecond
	DefaultRemoteMetricsTimeout  = 2 * time.Second
)

// GetInterval returns the scrape interval with the default applied.
func (r *RemoteMetricsConfig) GetInterval() time.Duration {
	if r == nil || r.Interval == "" {
		return DefaultRemoteMetricsInterval
	}

	d, err := time.ParseDuration(r.Interval)
	if err != nil || d <= 0 {
		return DefaultRemoteMetricsInterval
	}

	return d
}

// GetTimeout returns the per-scrape timeout with the default applied. It
// bounds one HTTP request. The endpoints of one tick are scraped together, so
// a stalled endpoint costs only itself.
func (r *RemoteMetricsConfig) GetTimeout() time.Duration {
	if r == nil || r.Timeout == "" {
		return DefaultRemoteMetricsTimeout
	}

	d, err := time.ParseDuration(r.Timeout)
	if err != nil || d <= 0 {
		return DefaultRemoteMetricsTimeout
	}

	return d
}

// IsEnabled reports whether the feature runs, which keeps the nil check off
// every call site.
func (r *RemoteMetricsConfig) IsEnabled() bool {
	return r != nil && r.Enabled && len(r.Endpoints) > 0
}

// Validate rejects an endpoint list that cannot mean what it says.
//
// An unset substitution leaves a URL with no host, which resolves to the
// machine running the benchmark. Every endpoint would then report that one
// machine under a different node, and no scrape would fail. A run must stop
// rather than publish that.
func (r *RemoteMetricsConfig) Validate() error {
	if !r.IsEnabled() {
		return nil
	}

	seen := make(map[string]struct{}, len(r.Endpoints))

	for i, endpoint := range r.Endpoints {
		if len(endpoint.Labels) == 0 {
			return fmt.Errorf("remote_metrics endpoint %d has no labels to identify its node", i)
		}

		if _, known := remotemetrics.ArtifactNames[endpoint.Kind]; !known {
			return fmt.Errorf("remote_metrics endpoint %d kind %q is not %s or %s",
				i, endpoint.Kind, remotemetrics.ExporterDCGM, remotemetrics.ExporterNode)
		}

		// The same node and kind twice would fold two expositions into one
		// device, so the label set identifies an endpoint together with its
		// kind.
		key := endpoint.Kind + " " + remotemetrics.LabelKey(endpoint.Labels)
		if _, duplicate := seen[key]; duplicate {
			return fmt.Errorf("remote_metrics lists the %s endpoint %s twice", endpoint.Kind, remotemetrics.LabelKey(endpoint.Labels))
		}

		seen[key] = struct{}{}

		parsed, err := url.Parse(endpoint.URL)
		if err != nil {
			return fmt.Errorf("remote_metrics endpoint %d has an unreadable url %q: %w", i, endpoint.URL, err)
		}

		if parsed.Hostname() == "" {
			return fmt.Errorf("remote_metrics endpoint %d has no host in url %q", i, endpoint.URL)
		}
	}

	return nil
}

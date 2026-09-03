package config

import (
	"fmt"
	"net/url"
	"time"
)

// RemoteMetricsConfig scrapes Prometheus text endpoints on remote hosts and
// records a reduced window for every block a run executes.
//
// The feature is generic. Any exporter that serves the Prometheus text format
// works, because the counter and gauge distinction travels in the TYPE lines
// of the exposition. A GPU exporter and a stock node exporter are both just
// endpoints.
type RemoteMetricsConfig struct {
	Enabled   bool                   `yaml:"enabled" mapstructure:"enabled"`
	Interval  string                 `yaml:"interval,omitempty" mapstructure:"interval"` // default 100ms
	Timeout   string                 `yaml:"timeout,omitempty" mapstructure:"timeout"`   // default 2s
	Endpoints []RemoteMetricEndpoint `yaml:"endpoints" mapstructure:"endpoints"`
}

// RemoteMetricEndpoint is one exposition to scrape.
//
// Name identifies the endpoint in the results and must not carry a hostname,
// because results are published. Labels are attached to every series the
// endpoint reports, which is how node identity reaches the results without
// the exporter having to know it.
type RemoteMetricEndpoint struct {
	Name   string            `yaml:"name" mapstructure:"name"`
	URL    string            `yaml:"url" mapstructure:"url"`
	Labels map[string]string `yaml:"labels,omitempty" mapstructure:"labels"`
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
// machine under a different node name, and no scrape would fail. A run must
// stop rather than publish that.
func (r *RemoteMetricsConfig) Validate() error {
	if !r.IsEnabled() {
		return nil
	}

	seen := make(map[string]struct{}, len(r.Endpoints))

	for i, endpoint := range r.Endpoints {
		if endpoint.Name == "" {
			return fmt.Errorf("remote_metrics endpoint %d has no name", i)
		}

		if _, duplicate := seen[endpoint.Name]; duplicate {
			return fmt.Errorf("remote_metrics endpoint name %q is used twice", endpoint.Name)
		}

		seen[endpoint.Name] = struct{}{}

		parsed, err := url.Parse(endpoint.URL)
		if err != nil {
			return fmt.Errorf("remote_metrics endpoint %q has an unreadable url %q: %w",
				endpoint.Name, endpoint.URL, err)
		}

		if parsed.Hostname() == "" {
			return fmt.Errorf("remote_metrics endpoint %q has no host in url %q",
				endpoint.Name, endpoint.URL)
		}
	}

	return nil
}

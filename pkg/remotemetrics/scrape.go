// Package remotemetrics scrapes Prometheus text endpoints on remote hosts and
// reduces the samples into per-test windows.
//
// The package holds no knowledge of any particular exporter. It learns which
// series are counters and which are gauges from the TYPE lines of the
// exposition, so a GPU exporter and a stock node exporter both work with no
// code change.
package remotemetrics

import (
	"context"
	"fmt"
	"io"
	"math"
	"net/http"
	"sort"
	"strings"
	"sync"
	"time"

	dto "github.com/prometheus/client_model/go"
	"github.com/prometheus/common/expfmt"
)

// maxAge bounds the rolling buffer. A window is cut as soon as its test ends,
// so nothing older than the longest plausible test is ever read again.
const maxAge = 15 * time.Minute

// staleReadingFactor sets how many poll intervals may pass between readings
// before the span between them counts as unobserved. A window resting on such
// a span is rejected rather than interpolated across.
const staleReadingFactor = 5

// windowGapShare bounds an unobserved span as a share of the window it falls
// in, so the tolerance grows with the block being measured.
const windowGapShare = 5

// Kind separates a counter, which a window subtracts, from a gauge, which a
// window averages.
type Kind int

const (
	KindGauge Kind = iota
	KindCounter
)

// Endpoint is one remote exposition to scrape.
type Endpoint struct {
	// Name identifies the endpoint in the results. It never carries a
	// hostname, because results are published.
	Name string
	// URL is the exposition to fetch.
	URL string
	// Labels are attached to every series the endpoint reports, which is how
	// a node identity reaches the results without the exporter knowing it.
	Labels map[string]string
}

// series identifies one metric of one device.
type series struct {
	metric string
	device string
}

// point is one reading, stamped when the scrape completed rather than by the
// remote host. Rig nodes run no time synchronisation, so a remote clock
// cannot be compared against a window measured here.
type point struct {
	at    time.Time
	value float64
}

// Scraper polls every endpoint and keeps a rolling buffer of what it read.
type Scraper struct {
	endpoints []Endpoint
	interval  time.Duration
	client    *http.Client

	mu      sync.Mutex
	kinds   map[string]Kind
	points  map[series][]point
	devices map[string]map[string]string
	failed  int
}

// NewScraper builds a scraper over the given endpoints.
func NewScraper(endpoints []Endpoint, interval, timeout time.Duration) *Scraper {
	return &Scraper{
		endpoints: endpoints,
		interval:  interval,
		client:    &http.Client{Timeout: timeout},
		kinds:     map[string]Kind{},
		points:    map[series][]point{},
		devices:   map[string]map[string]string{},
	}
}

// Run polls every endpoint until the context ends. A scrape failure is
// counted and skipped, because a benchmark must not fail over telemetry.
//
// Each endpoint keeps its own schedule. Sharing one, a host that accepts a
// connection and never answers would hold the whole loop for its timeout, and
// every other host would lose resolution because of it.
func (s *Scraper) Run(ctx context.Context) {
	var running sync.WaitGroup

	for _, endpoint := range s.endpoints {
		running.Add(1)

		go func() {
			defer running.Done()
			s.poll(ctx, endpoint)
		}()
	}

	running.Add(1)

	go func() {
		defer running.Done()

		ticker := time.NewTicker(s.interval)
		defer ticker.Stop()

		for {
			select {
			case <-ctx.Done():
				return
			case <-ticker.C:
				s.trim()
			}
		}
	}()

	running.Wait()
}

// poll scrapes one endpoint until the context ends.
func (s *Scraper) poll(ctx context.Context, endpoint Endpoint) {
	ticker := time.NewTicker(s.interval)
	defer ticker.Stop()

	for {
		select {
		case <-ctx.Done():
			return
		case <-ticker.C:
			if err := s.scrape(ctx, endpoint); err != nil {
				s.mu.Lock()
				s.failed++
				s.mu.Unlock()
			}
		}
	}
}

// hasDataPast reports whether any reading arrived after an instant. A window
// that still cannot be reduced once this is true will never reduce, so a
// caller stops waiting for it.
func (s *Scraper) hasDataPast(at time.Time) bool {
	s.mu.Lock()
	defer s.mu.Unlock()
	for _, points := range s.points {
		if len(points) > 0 && points[len(points)-1].at.After(at) {
			return true
		}
	}
	return false
}

// kindOf reports how a metric reduces, which the exposition declared.
func (s *Scraper) kindOf(metric string) Kind {
	s.mu.Lock()
	defer s.mu.Unlock()
	return s.kinds[metric]
}

// Failures reports how many scrapes failed, so a caller can warn once rather
// than per scrape.
func (s *Scraper) Failures() int {
	s.mu.Lock()
	defer s.mu.Unlock()
	return s.failed
}

// scrape fetches one endpoint and records every sample it carries.
func (s *Scraper) scrape(ctx context.Context, endpoint Endpoint) error {
	request, err := http.NewRequestWithContext(ctx, http.MethodGet, endpoint.URL, nil)
	if err != nil {
		return err
	}
	resp, err := s.client.Do(request)
	if err != nil {
		return err
	}
	defer func() { _ = resp.Body.Close() }()
	if resp.StatusCode != http.StatusOK {
		_, _ = io.Copy(io.Discard, resp.Body)
		return fmt.Errorf("%s returned %s", endpoint.URL, resp.Status)
	}

	var parser expfmt.TextParser
	families, err := parser.TextToMetricFamilies(resp.Body)
	if err != nil {
		return fmt.Errorf("parsing %s: %w", endpoint.URL, err)
	}
	// The scrape instant is taken once, after the body arrives, so every
	// series of one scrape shares a single consistent stamp.
	at := time.Now()

	s.mu.Lock()
	defer s.mu.Unlock()
	for name, family := range families {
		kind := KindGauge
		if family.GetType() == dto.MetricType_COUNTER {
			kind = KindCounter
		}
		s.kinds[name] = kind
		for _, metric := range family.GetMetric() {
			value, ok := sampleValue(metric, family.GetType())
			if !ok {
				continue
			}
			device := deviceKey(endpoint, metric)
			if _, seen := s.devices[device]; !seen {
				s.devices[device] = deviceLabels(endpoint, metric)
			}
			key := series{metric: name, device: device}
			s.points[key] = append(s.points[key], point{at: at, value: value})
		}
	}
	return nil
}

// sampleValue reads the number a metric carries. Only counters and gauges take
// part, because a window has no meaning for a histogram or a summary.
//
// A value that is not finite is refused. An exposition reports a field it
// cannot read as NaN, and NaN compares false against everything, so it would
// pass the counter reset guard and reduce into a statistic that no later
// stage can recognise as wrong.
func sampleValue(metric *dto.Metric, kind dto.MetricType) (float64, bool) {
	switch kind {
	case dto.MetricType_COUNTER:
		if metric.GetCounter() == nil {
			return 0, false
		}
		return finite(metric.GetCounter().GetValue())
	case dto.MetricType_GAUGE, dto.MetricType_UNTYPED:
		if metric.GetGauge() != nil {
			return finite(metric.GetGauge().GetValue())
		}
		if metric.GetUntyped() != nil {
			return finite(metric.GetUntyped().GetValue())
		}
		return 0, false
	default:
		return 0, false
	}
}

// finite refuses a reading that cannot be reduced or stored.
func finite(value float64) (float64, bool) {
	if math.IsNaN(value) || math.IsInf(value, 0) {
		return 0, false
	}
	return value, true
}

// deviceKey renders the endpoint and the metric labels into one stable
// identifier. The endpoint name leads, so two nodes never collide.
func deviceKey(endpoint Endpoint, metric *dto.Metric) string {
	parts := make([]string, 0, len(metric.GetLabel())+1)
	parts = append(parts, endpoint.Name)
	for _, label := range metric.GetLabel() {
		parts = append(parts, label.GetName()+"="+label.GetValue())
	}
	sort.Strings(parts[1:])
	return strings.Join(parts, ",")
}

// deviceLabels records what a device is, once, rather than repeating it on
// every sample.
func deviceLabels(endpoint Endpoint, metric *dto.Metric) map[string]string {
	labels := map[string]string{}
	for name, value := range endpoint.Labels {
		labels[name] = value
	}
	for _, label := range metric.GetLabel() {
		labels[label.GetName()] = label.GetValue()
	}
	return labels
}

// trim drops readings no window can still need.
func (s *Scraper) trim() {
	cutoff := time.Now().Add(-maxAge)
	s.mu.Lock()
	defer s.mu.Unlock()
	for key, points := range s.points {
		keep := 0
		for keep < len(points) && points[keep].at.Before(cutoff) {
			keep++
		}
		// One reading before the cutoff stays, because a counter window
		// interpolates from the sample that precedes it.
		if keep > 0 {
			s.points[key] = points[keep-1:]
		}
	}
}

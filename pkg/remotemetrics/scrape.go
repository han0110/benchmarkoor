// Package remotemetrics scrapes Prometheus text endpoints on remote hosts and
// reduces the samples into per-test windows.
//
// The package learns which series are counters and which are gauges from the
// TYPE lines of the exposition. It records only the series the artifacts
// carry, which the preset of each exporter selects.
package remotemetrics

import (
	"context"
	"fmt"
	"io"
	"math"
	"net/http"
	"sort"
	"strconv"
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
	// Exporter names the kind of endpoint, which selects the series recorded
	// from it and the artifact its devices land in.
	Exporter string
	// URL is the exposition to fetch.
	URL string
	// Labels identify the node and are attached to every series the endpoint
	// reports, which is how a node identity reaches the results without the
	// exporter knowing it. They never carry a hostname, because results are
	// published.
	Labels map[string]string
	// DeviceIDs limits the endpoint to the GPUs it lists, matched against the
	// DCGM gpu label. An empty list keeps every device the exporter reports,
	// because the scrape reads it as no limit. A node that proves with a
	// subset of its GPUs stores the idle ones without it, and an idle device
	// pulls every mean down.
	DeviceIDs []int
}

// keeps reports whether a sample belongs to a device the endpoint records. A
// sample without a listed gpu label falls outside a device list, so a series
// of another kind never passes one.
func (e Endpoint) keeps(metric *dto.Metric) bool {
	if len(e.DeviceIDs) == 0 {
		return true
	}

	for _, label := range metric.GetLabel() {
		if label.GetName() != "gpu" {
			continue
		}

		for _, id := range e.DeviceIDs {
			if label.GetValue() == strconv.Itoa(id) {
				return true
			}
		}
	}

	return false
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

	mu        sync.Mutex
	kinds     map[string]Kind
	points    map[series][]point
	devices   map[string]map[string]string
	exporters map[string]string
	failed    map[string]Failure
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
		exporters: map[string]string{},
		failed:    map[string]Failure{},
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
				s.failed[endpoint.URL] = Failure{Count: s.failed[endpoint.URL].Count + 1, Last: err}
				s.mu.Unlock()
			}
		}
	}
}

// settled reports whether every series has a reading at or after an instant.
//
// Endpoints answer at different speeds, and a window is only complete once the
// slowest of them has caught up. Accepting the first endpoint to arrive would
// drop the slower one's devices from that block without a word.
func (s *Scraper) settled(at time.Time) bool {
	s.mu.Lock()
	defer s.mu.Unlock()

	if len(s.points) == 0 {
		return false
	}

	// This check mirrors covers, which needs a reading at or after the
	// window end to interpolate the closing edge from.
	for _, points := range s.points {
		if len(points) == 0 || points[len(points)-1].at.Before(at) {
			return false
		}
	}

	return true
}

// readinessGrace bounds the wait for an endpoint that has not caught up, so
// one that stopped answering costs its own rows rather than every block.
func (s *Scraper) readinessGrace() time.Duration {
	return s.interval * staleReadingFactor
}

// kindOf reports how a metric reduces, which the exposition declared.
func (s *Scraper) kindOf(metric string) Kind {
	s.mu.Lock()
	defer s.mu.Unlock()
	return s.kinds[metric]
}

// Failure counts the scrapes of one endpoint that failed and keeps the last
// error, which is what names the endpoint at fault when an artifact is missing.
type Failure struct {
	Count int
	Last  error
}

// Failures reports the failed scrapes by endpoint URL, so a caller can warn
// once per endpoint rather than per scrape.
func (s *Scraper) Failures() map[string]Failure {
	s.mu.Lock()
	defer s.mu.Unlock()
	failures := make(map[string]Failure, len(s.failed))
	for url, failure := range s.failed {
		failures[url] = failure
	}
	return failures
}

// scrape fetches one endpoint and records every sample it carries. An
// exposition without any series of the exporter is a failure, because a port
// that answers with the wrong service is otherwise invisible.
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

	// A preset that sums over a label maps many samples onto one series, so
	// the scrape is totalled before any of it reaches the buffer. One reading
	// per series per scrape is what the window reduction expects.
	rules := presets[endpoint.Exporter]
	totals := map[series]float64{}
	identities := map[string]map[string]string{}

	for name, family := range families {
		selections := rules.series[name]
		if len(selections) == 0 {
			continue
		}

		kind := KindGauge
		if family.GetType() == dto.MetricType_COUNTER {
			kind = KindCounter
		}

		s.mu.Lock()
		for _, sel := range selections {
			s.kinds[sel.name] = kind
		}
		s.mu.Unlock()

		for _, metric := range family.GetMetric() {
			if !endpoint.keeps(metric) {
				continue
			}

			value, ok := sampleValue(metric, family.GetType())
			if !ok {
				continue
			}

			device := deviceKey(endpoint, metric, rules)
			if _, seen := identities[device]; !seen {
				identities[device] = deviceLabels(endpoint, metric, rules)
			}

			for _, sel := range selections {
				if sel.matches(metric) {
					totals[series{metric: sel.name, device: device}] += value
				}
			}
		}
	}

	if len(totals) == 0 {
		// A device list that matches nothing empties the scrape as well, so
		// the message names it rather than blaming the exporter.
		if len(endpoint.DeviceIDs) > 0 {
			return fmt.Errorf("%s serves none of the %s series for device_ids %v", endpoint.URL, endpoint.Exporter, endpoint.DeviceIDs)
		}

		return fmt.Errorf("%s serves none of the %s series", endpoint.URL, endpoint.Exporter)
	}

	s.mu.Lock()
	defer s.mu.Unlock()

	for device, labels := range identities {
		if _, seen := s.devices[device]; !seen {
			s.devices[device] = labels
			s.exporters[device] = endpoint.Exporter
		}
	}

	for key, value := range totals {
		s.points[key] = append(s.points[key], point{at: at, value: value})
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

// deviceKey renders the endpoint labels and the metric labels into one stable
// identifier. The endpoint labels lead, so two nodes never collide, and a
// label the preset sums over is left out.
func deviceKey(endpoint Endpoint, metric *dto.Metric, rules preset) string {
	parts := make([]string, 0, len(metric.GetLabel()))
	for _, label := range metric.GetLabel() {
		if rules.identifies(label.GetName()) {
			parts = append(parts, label.GetName()+"="+label.GetValue())
		}
	}
	sort.Strings(parts)
	if len(parts) == 0 {
		return LabelKey(endpoint.Labels)
	}
	return LabelKey(endpoint.Labels) + "," + strings.Join(parts, ",")
}

// LabelKey renders a label set as sorted name=value pairs, which is how an
// endpoint is identified in the artifact and in a configuration.
func LabelKey(labels map[string]string) string {
	parts := make([]string, 0, len(labels))
	for name, value := range labels {
		parts = append(parts, name+"="+value)
	}
	sort.Strings(parts)
	return strings.Join(parts, ",")
}

// deviceLabels records what a device is, once, rather than repeating it on
// every sample.
func deviceLabels(endpoint Endpoint, metric *dto.Metric, rules preset) map[string]string {
	labels := map[string]string{}
	for name, value := range endpoint.Labels {
		labels[name] = value
	}
	for _, label := range metric.GetLabel() {
		if rules.identifies(label.GetName()) {
			labels[label.GetName()] = label.GetValue()
		}
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

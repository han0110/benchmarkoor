package remotemetrics

import (
	"bytes"
	"compress/gzip"
	"encoding/json"
	"math"
	"slices"
	"sort"
	"time"
)

// TestArtifactName is the per test file holding the readings of one proving
// window, written beside the step results of the test.
const TestArtifactName = "test.remote-metrics.json.gz"

// testSchemaVersion travels with the per test artifact so a reader can reject
// a shape it does not understand.
const testSchemaVersion = 1

// traceLookback bounds how far before a window the refresh preceding it is
// searched for. A busy card refreshes every poll, so the search ends at once.
// An idle card that stayed quiet longer than this starts its window without a
// refresh to measure rates from, and its first row carries none.
const traceLookback = 10 * time.Second

// traceColumn names one per refresh statistic of the per test artifact. A
// share divides a counter's advance by the reference counter's advance over
// the same refreshes, a rate divides it by the seconds between them, and a
// value is the gauge reading.
type traceColumn struct {
	metric    string
	stat      string
	reference string
}

func (c traceColumn) name() string {
	return c.metric + "." + c.stat
}

// traceColumns lists, per exporter and in column order, what the per test
// artifact carries. The test modal reads exactly this set, and a test fails
// when the two drift apart.
var traceColumns = map[string][]traceColumn{
	ExporterDCGM: {
		{metric: "DCGM_FI_PROF_SM_CYCLES_ACTIVE_TOTAL", stat: "share", reference: "DCGM_FI_PROF_SM_CYCLES_ELAPSED_TOTAL"},
		{metric: "DCGM_FI_PROF_INT_CYCLES_ACTIVE_TOTAL", stat: "share", reference: "DCGM_FI_PROF_SM_CYCLES_ELAPSED_TOTAL"},
		{metric: "DCGM_FI_PROF_PCIE_RX_BYTES_TOTAL", stat: "rate"},
		{metric: "DCGM_FI_PROF_PCIE_TX_BYTES_TOTAL", stat: "rate"},
		{metric: "DCGM_FI_DEV_POWER_VIOLATION", stat: "rate"},
		{metric: "DCGM_FI_DEV_THERMAL_VIOLATION", stat: "rate"},
		{metric: "DCGM_FI_DEV_POWER_USAGE", stat: "value"},
		{metric: "DCGM_FI_PROF_SM_OCCUPANCY", stat: "value"},
		{metric: "DCGM_FI_PROF_DRAM_ACTIVE", stat: "value"},
		{metric: "DCGM_FI_DEV_GPU_TEMP_MARGIN_CELSIUS", stat: "value"},
	},
	ExporterNode: {
		{metric: "node_cpu_busy_seconds_total", stat: "share", reference: "node_cpu_seconds_total"},
		{metric: "node_memory_MemAvailable_bytes", stat: "value"},
		{metric: "node_memory_MemTotal_bytes", stat: "value"},
	},
}

func traceColumnNames(exporter string) []string {
	names := make([]string, 0, len(traceColumns[exporter]))
	for _, column := range traceColumns[exporter] {
		names = append(names, column.name())
	}
	return names
}

// DeviceTrace holds the readings of one device inside a window, one row per
// source refresh. Every row starts with the offset from the window start in
// milliseconds and continues with one cell per trace column of the exporter.
type DeviceTrace struct {
	Device   string
	Exporter string
	Labels   map[string]string
	Rows     [][]*int64
}

// reading is what one scrape of one device carried, keyed by metric.
type reading struct {
	at     time.Time
	values map[string]float64
}

// Trace cuts every device's readings to the window and reports one row per
// refresh, which is a scrape whose counters differ from the scrape before it.
// A scrape the source had not refreshed for repeats the previous values and is
// left out, which is what an idle GPU produces most of the time.
func (s *Scraper) Trace(start, end time.Time) []DeviceTrace {
	s.mu.Lock()
	defer s.mu.Unlock()

	byDevice := map[string]map[string][]point{}
	for key, points := range s.points {
		if byDevice[key.device] == nil {
			byDevice[key.device] = map[string][]point{}
		}
		byDevice[key.device][key.metric] = points
	}

	devices := make([]string, 0, len(byDevice))
	for device := range byDevice {
		devices = append(devices, device)
	}
	sort.Strings(devices)

	var traces []DeviceTrace
	for _, device := range devices {
		exporter := s.exporters[device]
		rows := traceRows(readings(byDevice[device], start.Add(-traceLookback), end), s.kinds, traceColumns[exporter], start, s.interval)
		if len(rows) == 0 {
			continue
		}
		traces = append(traces, DeviceTrace{Device: device, Exporter: exporter, Labels: s.devices[device], Rows: rows})
	}
	return traces
}

// readings aligns the series of one device by scrape instant over [from, to].
// Every series of one scrape shares a single stamp, so equal instants belong
// to one reading.
func readings(metrics map[string][]point, from, to time.Time) []reading {
	byInstant := map[time.Time]map[string]float64{}
	for metric, points := range metrics {
		first := sort.Search(len(points), func(i int) bool { return !points[i].at.Before(from) })
		for _, p := range points[first:] {
			if p.at.After(to) {
				break
			}
			if byInstant[p.at] == nil {
				byInstant[p.at] = map[string]float64{}
			}
			byInstant[p.at][metric] = p.value
		}
	}

	out := make([]reading, 0, len(byInstant))
	for at, values := range byInstant {
		out = append(out, reading{at: at, values: values})
	}
	sort.Slice(out, func(i, j int) bool { return out[i].at.Before(out[j].at) })
	return out
}

// pendingRow is a row whose rate cell waits for the counter to advance.
type pendingRow struct {
	row int
	at  time.Time
}

// traceRows walks the readings in time order and measures every row against
// the refresh before it. Readings before the window only move that base, so
// the first row inside it rests on the refresh that preceded it rather than
// on the window edge.
//
// The first buffered reading may itself repeat an older refresh. Its values
// are still those of that refresh, so a share measured from it holds, both
// counters having advanced over the same span. Its stamp is not the refresh
// instant, so a rate measured from it would not, and rates wait for a
// reading that changed against the one before it.
//
// The counters of one device do not share a refresh period, so every rate
// column keeps its own base at the reading where that counter last changed.
// One base for all of them divides a slow counter's advance by the period of
// the fastest and reads several times too high.
//
// An advance accumulates over the whole interval since its base, so its rate
// fills every row of that interval. A row after the last advance stays null
// while the interval holding it can still close inside the window, and reads
// zero once it lies further past that advance than the longest gap between
// two advances. A counter that never advances reads zero in every row, and
// one that advances once has no observed period, so its rows stay null.
func traceRows(all []reading, kinds map[string]Kind, columns []traceColumn, start time.Time, interval time.Duration) [][]*int64 {
	var rows [][]*int64
	var previous *reading
	bases := map[string]*reading{}
	advances := map[string]time.Time{}
	periods := map[string]time.Duration{}
	pending := map[string][]pendingRow{}
	unmeasured := map[string][]pendingRow{}
	for i := range all {
		current := &all[i]
		if i > 0 && !refreshed(all[i-1], *current, kinds) {
			continue
		}
		row := -1
		if !current.at.Before(start) {
			rows = append(rows, traceRow(previous, *current, columns, start))
			row = len(rows) - 1
		}
		for cell, column := range columns {
			value, ok := current.values[column.metric]
			if column.stat != "rate" || !ok {
				continue
			}
			if row >= 0 {
				pending[column.metric] = append(pending[column.metric], pendingRow{row: row, at: current.at})
			}
			if previous == nil {
				continue
			}
			// A previous reading without the counter reads zero and would
			// fabricate an advance.
			before, had := previous.values[column.metric]
			if !had || value == before {
				continue
			}
			// An interval that closes without a rate, at a reset or before the
			// first base, leaves its rows for the tail rule. The next advance
			// does not cover them.
			if measure := rate(bases[column.metric], *current, column, interval); measure != nil {
				for _, filled := range pending[column.metric] {
					rows[filled.row][cell+1] = measure
				}
			} else {
				unmeasured[column.metric] = append(unmeasured[column.metric], pending[column.metric]...)
			}
			pending[column.metric] = nil
			if value > before {
				if last := advances[column.metric]; !last.IsZero() {
					periods[column.metric] = max(periods[column.metric], current.at.Sub(last))
				}
				advances[column.metric] = current.at
			}
			bases[column.metric] = current
		}
		previous = current
	}
	for cell, column := range columns {
		if column.stat != "rate" {
			continue
		}
		last, period := advances[column.metric], periods[column.metric]
		for _, waiting := range slices.Concat(unmeasured[column.metric], pending[column.metric]) {
			if last.IsZero() || (period > 0 && waiting.at.Sub(last) > period) {
				rows[waiting.row][cell+1] = measured(0)
			}
		}
	}
	return rows
}

// refreshed reports whether any counter moved between two readings. A reading
// without counters counts as a refresh, because nothing else can tell.
func refreshed(previous, current reading, kinds map[string]Kind) bool {
	counters := 0
	for metric, value := range current.values {
		if kinds[metric] != KindCounter {
			continue
		}
		counters++
		if before, ok := previous.values[metric]; !ok || before != value {
			return true
		}
	}
	return counters == 0
}

// traceRow renders one refresh. Shares are measured against the previous
// reading, and every rate is left for traceRows to fill once its counter
// advances again. A metric the reading lacks, a share whose reference did not
// move, and a counter that fell all read null rather than zero.
func traceRow(previous *reading, current reading, columns []traceColumn, start time.Time) []*int64 {
	row := make([]*int64, 0, 1+len(columns))
	row = append(row, measured(current.at.Sub(start).Milliseconds()))
	for _, column := range columns {
		value, ok := current.values[column.metric]
		if !ok {
			row = append(row, nil)
			continue
		}
		switch column.stat {
		case "value":
			row = append(row, quantise(value, gaugeScale))
		case "share":
			row = append(row, share(previous, current, column))
		case "rate":
			row = append(row, nil)
		}
	}
	return row
}

// advance reports how far a counter moved from the base to the reading.
func advance(base *reading, current reading, metric string) (float64, bool) {
	if base == nil {
		return 0, false
	}
	before, ok := base.values[metric]
	if !ok || current.values[metric] < before {
		return 0, false
	}
	return current.values[metric] - before, true
}

func share(base *reading, current reading, column traceColumn) *int64 {
	numerator, ok := advance(base, current, column.metric)
	if !ok {
		return nil
	}
	denominator, ok := advance(base, current, column.reference)
	if !ok || denominator == 0 {
		return nil
	}
	// The two counters can come from different refreshes of the source when
	// a scrape lands between their updates, which pushes the quotient past
	// one. The cap keeps such a torn read from towering over the chart.
	return quantise(math.Min(numerator/denominator, 1), gaugeScale)
}

func rate(base *reading, current reading, column traceColumn, interval time.Duration) *int64 {
	moved, ok := advance(base, current, column.metric)
	if !ok {
		return nil
	}
	span := current.at.Sub(base.at).Seconds()
	if span <= 0 {
		return nil
	}
	return quantise(moved/math.Max(span, interval.Seconds()), 1)
}

// TestArtifact is the per test file, one section per exporter that had a
// device in the window.
type TestArtifact struct {
	SchemaVersion int                      `json:"schemaVersion"`
	Exporters     map[string]ExporterTrace `json:"exporters"`
}

// ExporterTrace holds the traced devices of one exporter. Samples[i] are the
// rows of Devices[i], each indexed by Columns.
type ExporterTrace struct {
	Columns []string     `json:"columns"`
	Devices []Device     `json:"devices"`
	Samples [][][]*int64 `json:"samples"`
}

// encodeTraces renders the traces as the gzip compressed per test artifact.
// The file is written once and read by a browser, so it takes the slowest
// compression level.
func encodeTraces(traces []DeviceTrace) []byte {
	artifact := TestArtifact{SchemaVersion: testSchemaVersion, Exporters: map[string]ExporterTrace{}}
	for _, trace := range traces {
		section, ok := artifact.Exporters[trace.Exporter]
		if !ok {
			section = ExporterTrace{Columns: append([]string{"at_ms"}, traceColumnNames(trace.Exporter)...)}
		}
		section.Devices = append(section.Devices, Device{Key: trace.Device, Labels: trace.Labels})
		section.Samples = append(section.Samples, trace.Rows)
		artifact.Exporters[trace.Exporter] = section
	}

	// The artifact holds only integers, strings, and nulls, and the writer
	// fills a buffer, so neither encoding nor compression can fail.
	var buffer bytes.Buffer
	writer, err := gzip.NewWriterLevel(&buffer, gzip.BestCompression)
	if err != nil {
		panic(err)
	}
	if err := json.NewEncoder(writer).Encode(artifact); err != nil {
		panic(err)
	}
	if err := writer.Close(); err != nil {
		panic(err)
	}
	return buffer.Bytes()
}

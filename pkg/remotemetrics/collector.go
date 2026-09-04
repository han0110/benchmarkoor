package remotemetrics

import (
	"encoding/json"
	"math"
	"os"
	"path/filepath"
	"sort"
	"sync"
	"time"
)

// schemaVersion travels with the artifact so a reader can reject a shape it
// does not understand. Version 1 stores the totals of secondsCounters at
// gaugeScale and every other counter total whole.
const schemaVersion = 1

// Artifact is the reduced result of a whole run.
//
// The layout is columnar, because a run holds one row per block per device
// and a rig of sixteen devices over several thousand blocks makes the row
// count the only thing that matters. Column names and device labels are
// written once, and every row is a bare number array indexed by Columns.
//
// A column the window could not measure is null. A row is positional, so the
// column cannot be left out. It must not be zero, because an idle device and
// an unobserved device are different results.
type Artifact struct {
	SchemaVersion int                              `json:"schemaVersion"`
	Columns       []string                         `json:"columns"`
	Devices       []Device                         `json:"devices"`
	Tests         map[string]map[string][][]*int64 `json:"tests"`
}

// Device names one source of metrics.
type Device struct {
	Key    string            `json:"key"`
	Labels map[string]string `json:"labels"`
}

// leadingColumns precede the metric values in every row.
//
// The window duration travels with the row so a reader can turn a counter
// total into a share of the block. Nanoseconds throttled mean nothing until
// they are divided by the time the block took.
var leadingColumns = []string{"device", "scrapes", "updates", "duration_ms"}

// gaugeScale fixes gauge precision. A ratio carries four decimals, which is
// finer than the hardware reports, and an integer costs fewer bytes than the
// same number with a decimal point.
const gaugeScale = 10000

// secondsCounters names the counters measured in seconds. A second is coarse
// against a block window, so these keep four decimals while a count of events
// stays whole.
var secondsCounters = set("node_cpu_seconds_total", "node_cpu_busy_seconds_total")

// statistic picks one named statistic out of a reduced metric, with the scale
// it is stored at. A counter carries a total and a peak rate. A gauge carries
// a mean, a minimum and a maximum. A name of the other kind reports nothing
// rather than a zero.
func statistic(stat Stat, kind Kind, metric, name string) (float64, float64, bool) {
	switch {
	case kind == KindCounter && name == "total":
		if _, seconds := secondsCounters[metric]; seconds {
			return stat.Total, gaugeScale, true
		}
		return stat.Total, 1, true
	case kind == KindCounter && name == "rate_max":
		return stat.PeakRate, 1, true
	case kind == KindGauge && name == "mean":
		return stat.Mean, gaugeScale, true
	case kind == KindGauge && name == "min":
		return stat.Min, gaugeScale, true
	case kind == KindGauge && name == "max":
		return stat.Max, gaugeScale, true
	}

	return 0, 0, false
}

// quantise renders a statistic as an integer. It reports nothing for a value
// int64 cannot hold, so an overflow never lands in the artifact looking like a
// measurement.
func quantise(value, scale float64) *int64 {
	scaled := math.Round(value * scale)
	if math.IsNaN(scaled) || scaled >= math.MaxInt64 || scaled <= math.MinInt64 {
		return nil
	}

	whole := int64(scaled)

	return &whole
}

// measured wraps a count that always exists, such as a row's leading columns.
func measured(value int64) *int64 {
	return &value
}

// Collector cuts a window for every block the executor times and holds the
// reduced result until the run ends. Rows are kept in one table per exporter,
// because each kind of device carries its own columns and lands in its own
// file.
type Collector struct {
	scraper *Scraper

	// TestWriter receives the readings of every settled window, proved block
	// or failed attempt, as the per test artifact, keyed by the test file.
	// Left nil, no per test file is written. A test with more than one window
	// keeps the last.
	TestWriter func(testFile string, data []byte)

	mu      sync.Mutex
	tables  map[string]*table
	blocks  int
	pending []pending
	dropped int
}

// table is the artifact of one exporter as it accumulates.
type table struct {
	devices []string
	index   map[string]int
	labels  map[string]map[string]string
	columns []string
	column  map[string]int
	tests   map[string]map[string][][]*int64
}

// table returns the table of an exporter, creating it on first use. The
// caller holds the lock.
func (c *Collector) table(exporter string) *table {
	t, ok := c.tables[exporter]
	if !ok {
		t = &table{
			index:  map[string]int{},
			labels: map[string]map[string]string{},
			column: map[string]int{},
			tests:  map[string]map[string][][]*int64{},
		}
		c.tables[exporter] = t
	}
	return t
}

// pending is a window waiting for the samples that cover it. Only a proved
// block reduces into the artifact tables, an attempt yields its trace alone.
type pending struct {
	testFile  string
	blockHash string
	start     time.Time
	end       time.Time
	proved    bool
}

// NewCollector builds a collector over a running scraper.
func NewCollector(scraper *Scraper) *Collector {
	return &Collector{scraper: scraper, tables: map[string]*table{}}
}

// RecordBlock queues one block's window. The executor calls this the instant
// the RPC returns, so the newest sample is always older than the window end
// and the window cannot be reduced yet. Every queued window is retried as
// later blocks arrive and once more before the artifact is written.
func (c *Collector) RecordBlock(testFile, blockHash string, start, end time.Time) {
	c.record(testFile, blockHash, start, end, true)
}

// RecordAttempt queues the window of a call that failed without a retry. The
// test receives its trace, so the readings around the failure can be read,
// while the artifact tables stay limited to proved blocks.
func (c *Collector) RecordAttempt(testFile, blockHash string, start, end time.Time) {
	c.record(testFile, blockHash, start, end, false)
}

func (c *Collector) record(testFile, blockHash string, start, end time.Time, proved bool) {
	if !end.After(start) {
		return
	}

	c.mu.Lock()
	c.pending = append(c.pending, pending{testFile: testFile, blockHash: blockHash, start: start, end: end, proved: proved})
	c.mu.Unlock()

	c.flush()
}

// flush reduces every queued window whose samples have caught up. A window
// that still cannot be reduced after every series caught up, or the grace
// passed, never will. It is counted rather than retried forever.
//
// The queue is ordered by window end, because blocks are executed in turn. A
// window that must still wait therefore proves that every window behind it
// must wait too, and the scan stops there. Without that stop, a source that
// stopped answering would make the queue grow while every block re-reduced
// all of it.
func (c *Collector) flush() {
	c.mu.Lock()
	queued := c.pending
	c.pending = nil
	c.mu.Unlock()

	for index, block := range queued {
		// A block waits for every series to catch up, for at most the
		// readiness grace, so a slow endpoint keeps its rows and a dead one
		// costs only its own.
		if !c.scraper.settled(block.end) &&
			time.Since(block.end) < c.scraper.readinessGrace() {
			c.mu.Lock()
			c.pending = append(append([]pending{}, queued[index:]...), c.pending...)
			c.mu.Unlock()

			return
		}

		if block.proved {
			windows := c.scraper.Reduce(block.start, block.end)
			if len(windows) == 0 {
				c.mu.Lock()
				c.dropped++
				c.mu.Unlock()

				continue
			}

			c.mu.Lock()
			rows := map[string][][]*int64{}
			for _, window := range windows {
				rows[window.Exporter] = append(rows[window.Exporter], c.row(window, block.end.Sub(block.start)))
			}

			for exporter, exporterRows := range rows {
				t := c.table(exporter)
				if t.tests[block.testFile] == nil {
					t.tests[block.testFile] = map[string][][]*int64{}
				}
				t.tests[block.testFile][block.blockHash] = exporterRows
			}

			c.blocks++
			c.mu.Unlock()
		}

		if c.TestWriter != nil {
			if traces := c.scraper.Trace(block.start, block.end); len(traces) > 0 {
				c.TestWriter(block.testFile, encodeTraces(traces))
			}
		}
	}
}

// Settle waits for the readings the queued windows still need, up to timeout.
//
// The last block of a run ends after the newest scrape, and no later block
// arrives to carry it. Without this it would be dropped when the artifact is
// written, losing the final block of every run.
func (c *Collector) Settle(timeout time.Duration) {
	deadline := time.Now().Add(timeout)

	for {
		c.flush()

		c.mu.Lock()
		queued := len(c.pending)
		c.mu.Unlock()

		if queued == 0 || !time.Now().Before(deadline) {
			return
		}

		time.Sleep(settlePollInterval)
	}
}

// settlePollInterval paces Settle between flushes.
const settlePollInterval = 10 * time.Millisecond

// Dropped reports how many block windows carried no usable samples, so a
// caller can say plainly that telemetry was incomplete. A queued attempt is
// not one of them, since it holds no artifact row to lose.
func (c *Collector) Dropped() int {
	c.flush()

	c.mu.Lock()
	defer c.mu.Unlock()

	dropped := c.dropped
	for _, block := range c.pending {
		if block.proved {
			dropped++
		}
	}
	return dropped
}

// row renders one window into the columnar form of its exporter, adding any
// column the run has not seen before. Values are rounded, because a counter
// is a whole count and a gauge is finer than the hardware reports well past
// four decimals. The caller holds the lock.
func (c *Collector) row(window DeviceWindow, duration time.Duration) []*int64 {
	t := c.table(window.Exporter)
	// Sorted, because map order would otherwise decide the column layout and
	// two runs of the same input would not produce comparable artifacts.
	metrics := make([]string, 0, len(window.Metrics))
	for metric := range window.Metrics {
		metrics = append(metrics, metric)
	}

	sort.Strings(metrics)

	values := map[int]*int64{}

	for _, metric := range metrics {
		stat := window.Metrics[metric]
		kind := c.scraper.kindOf(metric)
		for _, name := range artifactColumns[window.Exporter][metric] {
			value, scale, ok := statistic(stat, kind, metric, name)
			if !ok {
				continue
			}
			values[t.columnIndex(metric, name)] = quantise(value, scale)
		}
	}

	// Every metric column starts null and takes only a statistic this
	// window produced.
	row := make([]*int64, len(leadingColumns)+len(t.columns))
	row[0] = measured(int64(t.deviceIndex(window)))
	row[1] = measured(int64(window.Scrapes))
	row[2] = measured(int64(window.Updates))
	row[3] = measured(duration.Milliseconds())

	for position, value := range values {
		row[len(leadingColumns)+position] = value
	}
	return row
}

// columnIndex assigns each metric statistic a stable position.
func (t *table) columnIndex(metric, stat string) int {
	name := metric + "." + stat
	if position, ok := t.column[name]; ok {
		return position
	}
	position := len(t.columns)
	t.column[name] = position
	t.columns = append(t.columns, name)
	return position
}

// deviceIndex assigns each device a stable position in the artifact table.
func (t *table) deviceIndex(window DeviceWindow) int {
	if position, ok := t.index[window.Device]; ok {
		return position
	}
	position := len(t.devices)
	t.index[window.Device] = position
	t.devices = append(t.devices, window.Device)
	t.labels[window.Device] = window.Labels
	return position
}

// Blocks reports how many block windows were recorded, so a caller can say
// plainly whether any telemetry reached the results. It resolves what it can
// first, because the last blocks of a run are still queued.
func (c *Collector) Blocks() int {
	c.flush()

	c.mu.Lock()
	defer c.mu.Unlock()

	return c.blocks
}

// Write saves one artifact per exporter into dir and reports the paths
// written. An exporter with no window recorded writes no file, so an empty
// file never suggests a device that did no work.
func (c *Collector) Write(dir string) ([]string, error) {
	c.flush()

	c.mu.Lock()
	defer c.mu.Unlock()

	exporters := make([]string, 0, len(c.tables))
	for exporter := range c.tables {
		exporters = append(exporters, exporter)
	}
	sort.Strings(exporters)

	var paths []string
	for _, exporter := range exporters {
		t := c.tables[exporter]
		if len(t.tests) == 0 {
			continue
		}
		path := filepath.Join(dir, ArtifactNames[exporter])
		if err := os.WriteFile(path, t.encode(), 0o644); err != nil {
			return paths, err
		}
		paths = append(paths, path)
	}
	return paths, nil
}

// encode renders the table as the artifact. A row written before a later
// column appeared is short, so every row is padded to the final width rather
// than left ragged. The padding is null, marking a metric this window never
// carried.
func (t *table) encode() []byte {
	devices := make([]Device, 0, len(t.devices))
	for _, key := range t.devices {
		devices = append(devices, Device{Key: key, Labels: t.labels[key]})
	}
	width := len(leadingColumns) + len(t.columns)
	for _, blocks := range t.tests {
		for hash, rows := range blocks {
			for i, row := range rows {
				for len(row) < width {
					row = append(row, nil)
				}
				rows[i] = row
			}
			blocks[hash] = rows
		}
	}
	artifact := Artifact{
		SchemaVersion: schemaVersion,
		Columns:       append(append([]string{}, leadingColumns...), t.columns...),
		Devices:       devices,
		Tests:         t.tests,
	}
	// The artifact holds only integers, strings, and nulls, so encoding
	// cannot fail.
	data, err := json.Marshal(artifact)
	if err != nil {
		panic(err)
	}
	return data
}

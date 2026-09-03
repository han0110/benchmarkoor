package remotemetrics

import (
	"encoding/json"
	"math"
	"os"
	"sort"
	"sync"
	"time"
)

// ArtifactName is the file the collector writes beside the other per-run
// results.
const ArtifactName = "result.device-metrics.json"

// schemaVersion travels with the artifact so a reader can reject a shape it
// does not understand.
const schemaVersion = 1

// Artifact is the reduced result of a whole run.
//
// The layout is columnar, because a run holds one row per block per device
// and a rig of sixteen devices over several thousand blocks makes the row
// count the only thing that matters. Column names and device labels are
// written once, and every row is a bare number array indexed by Columns.
type Artifact struct {
	SchemaVersion int                             `json:"schemaVersion"`
	Columns       []string                        `json:"columns"`
	Devices       []Device                        `json:"devices"`
	Tests         map[string]map[string][][]int64 `json:"tests"`
}

// Device names one source of metrics.
type Device struct {
	Key    string            `json:"key"`
	Labels map[string]string `json:"labels"`
}

// leadingColumns precede the metric values in every row.
var leadingColumns = []string{"device", "scrapes", "updates"}

// gaugeScale fixes gauge precision. A ratio carries four decimals, which is
// finer than the hardware reports, and an integer costs fewer bytes than the
// same number with a decimal point.
const gaugeScale = 10000

// noReading marks a column the window could not measure. Zero cannot serve,
// because a device that did no work and a device that was never observed are
// different results and a reader must be able to tell them apart.
const noReading = math.MinInt64

// quantise renders a statistic as an integer, refusing a value int64 cannot
// hold so that an overflow never lands in the artifact as a real number.
func quantise(value, scale float64) int64 {
	scaled := math.Round(value * scale)
	if math.IsNaN(scaled) || scaled >= math.MaxInt64 || scaled <= math.MinInt64 {
		return noReading
	}
	return int64(scaled)
}

// Collector cuts a window for every block the executor times and holds the
// reduced result until the run ends.
type Collector struct {
	scraper *Scraper

	mu      sync.Mutex
	devices []string
	index   map[string]int
	labels  map[string]map[string]string
	columns []string
	column  map[string]int
	kinds   map[string]Kind
	tests   map[string]map[string][][]int64
	pending []pending
	dropped int
}

// pending is a block window waiting for the samples that cover it.
type pending struct {
	testFile  string
	blockHash string
	start     time.Time
	end       time.Time
}

// NewCollector builds a collector over a running scraper.
func NewCollector(scraper *Scraper) *Collector {
	return &Collector{
		scraper: scraper,
		index:   map[string]int{},
		labels:  map[string]map[string]string{},
		column:  map[string]int{},
		kinds:   map[string]Kind{},
		tests:   map[string]map[string][][]int64{},
	}
}

// RecordBlock queues one block's window. The executor calls this the instant
// the RPC returns, so the newest sample is always older than the window end
// and the window cannot be reduced yet. Every queued window is retried as
// later blocks arrive and once more before the artifact is written.
func (c *Collector) RecordBlock(testFile, blockHash string, start, end time.Time) {
	if !end.After(start) {
		return
	}

	c.mu.Lock()
	c.pending = append(c.pending, pending{testFile: testFile, blockHash: blockHash, start: start, end: end})
	c.mu.Unlock()

	c.flush()
}

// flush reduces every queued window whose samples have caught up. A window
// that still cannot be reduced once readings exist past its end never will,
// so it is counted rather than retried forever.
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
		windows := c.scraper.Reduce(block.start, block.end)
		if len(windows) == 0 {
			if !c.scraper.hasDataPast(block.end) {
				c.mu.Lock()
				c.pending = append(append([]pending{}, queued[index:]...), c.pending...)
				c.mu.Unlock()

				return
			}

			c.mu.Lock()
			c.dropped++
			c.mu.Unlock()

			continue
		}

		c.mu.Lock()
		if c.tests[block.testFile] == nil {
			c.tests[block.testFile] = map[string][][]int64{}
		}

		rows := make([][]int64, 0, len(windows))
		for _, window := range windows {
			rows = append(rows, c.row(window))
		}

		c.tests[block.testFile][block.blockHash] = rows
		c.mu.Unlock()
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
// caller can say plainly that telemetry was incomplete.
func (c *Collector) Dropped() int {
	c.flush()

	c.mu.Lock()
	defer c.mu.Unlock()

	return c.dropped + len(c.pending)
}

// row renders one window into the columnar form, adding any column the run
// has not seen before. Values are rounded, because a counter is a whole
// count and a gauge is finer than the hardware reports well past four
// decimals.
func (c *Collector) row(window DeviceWindow) []int64 {
	// Sorted, because map order would otherwise decide the column layout and
	// two runs of the same input would not produce comparable artifacts.
	metrics := make([]string, 0, len(window.Metrics))
	for metric := range window.Metrics {
		metrics = append(metrics, metric)
	}

	sort.Strings(metrics)

	values := map[int]int64{}

	for _, metric := range metrics {
		stat := window.Metrics[metric]
		kind := c.scraper.kindOf(metric)
		c.kinds[metric] = kind
		if kind == KindCounter {
			values[c.columnIndex(metric, "total")] = quantise(stat.Total, 1)
			continue
		}
		values[c.columnIndex(metric, "mean")] = quantise(stat.Mean, gaugeScale)
		values[c.columnIndex(metric, "min")] = quantise(stat.Min, gaugeScale)
		values[c.columnIndex(metric, "max")] = quantise(stat.Max, gaugeScale)
	}

	row := make([]int64, len(leadingColumns)+len(c.columns))
	row[0] = int64(c.deviceIndex(window))
	row[1] = int64(window.Scrapes)
	row[2] = int64(window.Updates)
	for position := len(leadingColumns); position < len(row); position++ {
		row[position] = noReading
	}
	for position, value := range values {
		row[len(leadingColumns)+position] = value
	}
	return row
}

// columnIndex assigns each metric statistic a stable position.
func (c *Collector) columnIndex(metric, stat string) int {
	name := metric + "." + stat
	if position, ok := c.column[name]; ok {
		return position
	}
	position := len(c.columns)
	c.column[name] = position
	c.columns = append(c.columns, name)
	return position
}

// deviceIndex assigns each device a stable position in the artifact table.
func (c *Collector) deviceIndex(window DeviceWindow) int {
	if position, ok := c.index[window.Device]; ok {
		return position
	}
	position := len(c.devices)
	c.index[window.Device] = position
	c.devices = append(c.devices, window.Device)
	c.labels[window.Device] = window.Labels
	return position
}

// Blocks reports how many block windows were recorded, so a caller can say
// plainly whether any telemetry reached the results. It resolves what it can
// first, because the last blocks of a run are still queued.
func (c *Collector) Blocks() int {
	c.flush()

	c.mu.Lock()
	defer c.mu.Unlock()

	var count int
	for _, blocks := range c.tests {
		count += len(blocks)
	}

	return count
}

// Write saves the artifact. It writes nothing when no window was recorded, so
// an empty file never suggests a GPU that did no work.
func (c *Collector) Write(path string) error {
	c.flush()

	c.mu.Lock()
	defer c.mu.Unlock()

	if len(c.tests) == 0 {
		return nil
	}

	devices := make([]Device, 0, len(c.devices))
	for _, key := range c.devices {
		devices = append(devices, Device{Key: key, Labels: c.labels[key]})
	}
	// A row written before a later column appeared is short, so pad every
	// row to the final width rather than leaving a ragged array. The padding
	// marks a metric this window never carried, not a measured zero.
	width := len(leadingColumns) + len(c.columns)
	for _, blocks := range c.tests {
		for hash, rows := range blocks {
			for i, row := range rows {
				for len(row) < width {
					row = append(row, noReading)
				}
				rows[i] = row
			}
			blocks[hash] = rows
		}
	}
	artifact := Artifact{
		SchemaVersion: schemaVersion,
		Columns:       append(append([]string{}, leadingColumns...), c.columns...),
		Devices:       devices,
		Tests:         c.tests,
	}
	data, err := json.Marshal(artifact)
	if err != nil {
		return err
	}
	return os.WriteFile(path, data, 0o644)
}

// MetricNames lists every metric the artifact carries, ordered.
func (c *Collector) MetricNames() []string {
	c.mu.Lock()
	defer c.mu.Unlock()
	names := make([]string, 0, len(c.kinds))
	for name := range c.kinds {
		names = append(names, name)
	}
	sort.Strings(names)
	return names
}

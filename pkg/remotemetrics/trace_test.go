package remotemetrics

import (
	"bytes"
	"compress/gzip"
	"encoding/json"
	"io"
	"os"
	"path/filepath"
	"regexp"
	"testing"
	"time"

	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"
)

// tracedScraper holds one busy GPU read every 100ms from 0 to 900ms. Elapsed
// cycles advance by 1000 per reading and active cycles by 800, so every
// interval is 80 percent active. PCIe bytes advance by one million per
// reading, power sits at 400W, and the reading at 500ms repeats the one at
// 400ms, as a scrape that landed before the source refreshed does.
func tracedScraper() *Scraper {
	s := NewScraper(nil, 100*time.Millisecond, time.Second)
	device := "node=node0,gpu=0"
	s.devices[device] = map[string]string{"node": "node0", "gpu": "0"}
	s.exporters[device] = ExporterDCGM
	for _, metric := range []string{
		"DCGM_FI_PROF_SM_CYCLES_ELAPSED_TOTAL", "DCGM_FI_PROF_SM_CYCLES_ACTIVE_TOTAL", "DCGM_FI_PROF_PCIE_RX_BYTES_TOTAL",
	} {
		s.kinds[metric] = KindCounter
	}
	s.kinds["DCGM_FI_DEV_POWER_USAGE"] = KindGauge

	var elapsed, active, bytes float64
	for i := 0; i < 10; i++ {
		if i != 5 {
			elapsed += 1000
			active += 800
			bytes += 1e6
		}
		add := func(metric string, value float64) {
			key := series{metric: metric, device: device}
			s.points[key] = append(s.points[key], point{at: at(i * 100), value: value})
		}
		add("DCGM_FI_PROF_SM_CYCLES_ELAPSED_TOTAL", elapsed)
		add("DCGM_FI_PROF_SM_CYCLES_ACTIVE_TOTAL", active)
		add("DCGM_FI_PROF_PCIE_RX_BYTES_TOTAL", bytes)
		add("DCGM_FI_DEV_POWER_USAGE", 400)
	}
	return s
}

func cell(t *testing.T, trace DeviceTrace, row int, column string) *int64 {
	t.Helper()
	for i, name := range traceColumnNames(trace.Exporter) {
		if name == column {
			return trace.Rows[row][i+1]
		}
	}
	t.Fatalf("no column %s", column)
	return nil
}

func TestTraceReportsOneRowPerRefreshInsideTheWindow(t *testing.T) {
	traces := tracedScraper().Trace(at(150), at(850))

	require.Len(t, traces, 1)
	trace := traces[0]
	assert.Equal(t, ExporterDCGM, trace.Exporter)
	assert.Equal(t, map[string]string{"node": "node0", "gpu": "0"}, trace.Labels)

	// Readings at 200 to 800 fall inside the window, and the one at 500
	// repeats 400, so six rows remain.
	require.Len(t, trace.Rows, 6)
	var offsets []int64
	for _, row := range trace.Rows {
		offsets = append(offsets, *row[0])
	}
	assert.Equal(t, []int64{50, 150, 250, 450, 550, 650}, offsets)

	// The first row rests on the reading at 100, which lies before the window.
	assert.EqualValues(t, 8000, *cell(t, trace, 0, "DCGM_FI_PROF_SM_CYCLES_ACTIVE_TOTAL.share"))
	assert.EqualValues(t, 1e7, *cell(t, trace, 0, "DCGM_FI_PROF_PCIE_RX_BYTES_TOTAL.rate"))
	assert.EqualValues(t, 400*gaugeScale, *cell(t, trace, 0, "DCGM_FI_DEV_POWER_USAGE.value"))

	// The row at 600 follows the refresh at 400 across the repeated reading,
	// so its rate spans 200ms rather than doubling.
	assert.EqualValues(t, 8000, *cell(t, trace, 3, "DCGM_FI_PROF_SM_CYCLES_ACTIVE_TOTAL.share"))
	assert.EqualValues(t, 5e6, *cell(t, trace, 3, "DCGM_FI_PROF_PCIE_RX_BYTES_TOTAL.rate"))

	// A metric the device never reported stays null rather than zero.
	assert.Nil(t, cell(t, trace, 0, "DCGM_FI_PROF_INT_CYCLES_ACTIVE_TOTAL.share"))
	assert.Nil(t, cell(t, trace, 0, "DCGM_FI_PROF_DRAM_ACTIVE.value"))
}

func TestTraceLeavesTheFirstRefreshWithoutABaseNull(t *testing.T) {
	// A window that starts before the first reading has nothing to
	// subtract from at its first refresh.
	traces := tracedScraper().Trace(at(-50), at(250))

	require.Len(t, traces, 1)
	rows := traces[0].Rows
	require.Len(t, rows, 3)
	assert.Nil(t, cell(t, traces[0], 0, "DCGM_FI_PROF_SM_CYCLES_ACTIVE_TOTAL.share"))
	assert.Nil(t, cell(t, traces[0], 0, "DCGM_FI_PROF_PCIE_RX_BYTES_TOTAL.rate"))
	assert.NotNil(t, cell(t, traces[0], 0, "DCGM_FI_DEV_POWER_USAGE.value"))
	assert.EqualValues(t, 8000, *cell(t, traces[0], 1, "DCGM_FI_PROF_SM_CYCLES_ACTIVE_TOTAL.share"))
}

// TestTraceRateWaitsForAConfirmedRefresh covers a card that sat idle past the
// lookback. Its first buffered reading repeats an older refresh at a later
// stamp, which is a sound base for a share and a wrong one for a rate.
func TestTraceRateWaitsForAConfirmedRefresh(t *testing.T) {
	s := NewScraper(nil, 100*time.Millisecond, time.Second)
	device := "node=node0,gpu=0"
	s.devices[device] = map[string]string{"node": "node0", "gpu": "0"}
	s.exporters[device] = ExporterDCGM
	s.kinds["DCGM_FI_PROF_SM_CYCLES_ELAPSED_TOTAL"] = KindCounter
	s.kinds["DCGM_FI_PROF_SM_CYCLES_ACTIVE_TOTAL"] = KindCounter
	s.kinds["DCGM_FI_PROF_PCIE_RX_BYTES_TOTAL"] = KindCounter
	add := func(offsetMs int, elapsed, active, bytes float64) {
		for metric, value := range map[string]float64{
			"DCGM_FI_PROF_SM_CYCLES_ELAPSED_TOTAL": elapsed,
			"DCGM_FI_PROF_SM_CYCLES_ACTIVE_TOTAL":  active,
			"DCGM_FI_PROF_PCIE_RX_BYTES_TOTAL":     bytes,
		} {
			key := series{metric: metric, device: device}
			s.points[key] = append(s.points[key], point{at: at(offsetMs), value: value})
		}
	}
	// Two repeated readings, then the source moves twice inside the window.
	add(0, 1000, 800, 1e6)
	add(100, 1000, 800, 1e6)
	add(200, 2000, 1600, 2e6)
	add(300, 3000, 2400, 3e6)

	traces := s.Trace(at(150), at(350))

	require.Len(t, traces, 1)
	require.Len(t, traces[0].Rows, 2)
	assert.EqualValues(t, 8000, *cell(t, traces[0], 0, "DCGM_FI_PROF_SM_CYCLES_ACTIVE_TOTAL.share"))
	assert.Nil(t, cell(t, traces[0], 0, "DCGM_FI_PROF_PCIE_RX_BYTES_TOTAL.rate"), "the first reading's stamp is not a refresh instant")
	assert.EqualValues(t, 1e7, *cell(t, traces[0], 1, "DCGM_FI_PROF_PCIE_RX_BYTES_TOTAL.rate"))
}

// TestTraceMeasuresARateFromItsOwnRefresh covers the violation counters,
// which the source refreshes every fifth reading. Measured from the row
// before, one advance of 500ms would divide by 100ms and read five times too
// high, and the four rows it spans would read zero.
func TestTraceMeasuresARateFromItsOwnRefresh(t *testing.T) {
	s := NewScraper(nil, 100*time.Millisecond, time.Second)
	device := "node=node0,gpu=0"
	s.devices[device] = map[string]string{"node": "node0", "gpu": "0"}
	s.exporters[device] = ExporterDCGM
	s.kinds["DCGM_FI_PROF_PCIE_RX_BYTES_TOTAL"] = KindCounter
	s.kinds["DCGM_FI_PROF_PCIE_TX_BYTES_TOTAL"] = KindCounter
	s.kinds["DCGM_FI_DEV_POWER_VIOLATION"] = KindCounter
	s.kinds["DCGM_FI_DEV_THERMAL_VIOLATION"] = KindCounter
	// PCIe bytes advance every reading. The violation counter advances half a
	// second of nanoseconds every 500ms, which is one second per second, and
	// first at 100ms, so the window opens on a counter that already has a
	// base. Its last advance lands at 1600ms, three readings before the end.
	// The thermal counter never advances, and the transmit counter advances
	// at 100ms and 600ms only.
	var bytes, transmitted, violation float64
	for i := 0; i < 20; i++ {
		bytes += 1e6
		if i == 1 || i == 6 {
			transmitted += 1e6
		}
		if i%5 == 1 {
			violation += 5e8
		}
		for metric, value := range map[string]float64{
			"DCGM_FI_PROF_PCIE_RX_BYTES_TOTAL": bytes,
			"DCGM_FI_PROF_PCIE_TX_BYTES_TOTAL": transmitted,
			"DCGM_FI_DEV_POWER_VIOLATION":      violation,
			"DCGM_FI_DEV_THERMAL_VIOLATION":    0,
		} {
			key := series{metric: metric, device: device}
			s.points[key] = append(s.points[key], point{at: at(i * 100), value: value})
		}
	}

	traces := s.Trace(at(150), at(1950))

	require.Len(t, traces, 1)
	require.Len(t, traces[0].Rows, 18)
	// Row 14 carries the advance at 1600ms, and the rows after it wait for an
	// interval the window does not close.
	for i := range traces[0].Rows {
		assert.EqualValues(t, 1e7, *cell(t, traces[0], i, "DCGM_FI_PROF_PCIE_RX_BYTES_TOTAL.rate"), "row %d", i)
		throttled := cell(t, traces[0], i, "DCGM_FI_DEV_POWER_VIOLATION.rate")
		if i > 14 {
			assert.Nil(t, throttled, "row %d", i)
			continue
		}
		require.NotNil(t, throttled, "row %d", i)
		assert.LessOrEqual(t, *throttled, int64(1e9), "row %d", i)
		assert.EqualValues(t, 1e9, *throttled, "row %d", i)
	}
	// The thermal counter measures zero in every row. The transmit counter
	// shows a 500ms period, so the rows past 1100ms read zero and the rows
	// before them wait for an advance.
	for i := range traces[0].Rows {
		idle := cell(t, traces[0], i, "DCGM_FI_DEV_THERMAL_VIOLATION.rate")
		require.NotNil(t, idle, "row %d", i)
		assert.Zero(t, *idle, "row %d", i)
		transmitted := cell(t, traces[0], i, "DCGM_FI_PROF_PCIE_TX_BYTES_TOTAL.rate")
		switch {
		case i < 5:
			require.NotNil(t, transmitted, "row %d", i)
			assert.EqualValues(t, 2e6, *transmitted, "row %d", i)
		case i < 10:
			assert.Nil(t, transmitted, "row %d", i)
		default:
			require.NotNil(t, transmitted, "row %d", i)
			assert.Zero(t, *transmitted, "row %d", i)
		}
	}
}

// TestTraceLeavesTheRowsAfterASingleAdvanceNull covers a counter that moved
// once. One advance shows no period, so the rows after it cannot be called
// idle and stay null. The thermal counter reaches its one advance through a
// reset, and a fall is no advance, so it shows no period either.
func TestTraceLeavesTheRowsAfterASingleAdvanceNull(t *testing.T) {
	s := NewScraper(nil, 100*time.Millisecond, time.Second)
	device := "node=node0,gpu=0"
	s.devices[device] = map[string]string{"node": "node0", "gpu": "0"}
	s.exporters[device] = ExporterDCGM
	s.kinds["DCGM_FI_PROF_PCIE_RX_BYTES_TOTAL"] = KindCounter
	s.kinds["DCGM_FI_DEV_POWER_VIOLATION"] = KindCounter
	s.kinds["DCGM_FI_DEV_THERMAL_VIOLATION"] = KindCounter
	var bytes, violation float64
	thermal := 1e9
	for i := 0; i < 10; i++ {
		bytes += 1e6
		if i == 2 {
			violation = 5e8
		}
		if i == 3 {
			thermal = 0
		}
		if i == 4 {
			thermal = 5e8
		}
		for metric, value := range map[string]float64{
			"DCGM_FI_PROF_PCIE_RX_BYTES_TOTAL": bytes,
			"DCGM_FI_DEV_POWER_VIOLATION":      violation,
			"DCGM_FI_DEV_THERMAL_VIOLATION":    thermal,
		} {
			key := series{metric: metric, device: device}
			s.points[key] = append(s.points[key], point{at: at(i * 100), value: value})
		}
	}

	traces := s.Trace(at(0), at(900))

	require.Len(t, traces, 1)
	require.Len(t, traces[0].Rows, 10)
	// Row 4 measures the advance that follows the reset, and every other row
	// of the thermal counter waits for a second advance the window never
	// brings.
	for i := range traces[0].Rows {
		assert.Nil(t, cell(t, traces[0], i, "DCGM_FI_DEV_POWER_VIOLATION.rate"), "row %d", i)
		thermal := cell(t, traces[0], i, "DCGM_FI_DEV_THERMAL_VIOLATION.rate")
		if i == 4 {
			require.NotNil(t, thermal)
			assert.EqualValues(t, 5e9, *thermal)
			continue
		}
		assert.Nil(t, thermal, "row %d", i)
	}
}

// TestTraceZeroesACounterThatOnlyFell covers a counter that resets and never
// advances. The reset closes the rows before it without a rate, and a counter
// that never advanced measures zero, so every row reads zero.
func TestTraceZeroesACounterThatOnlyFell(t *testing.T) {
	s := NewScraper(nil, 100*time.Millisecond, time.Second)
	device := "node=node0,gpu=0"
	s.devices[device] = map[string]string{"node": "node0", "gpu": "0"}
	s.exporters[device] = ExporterDCGM
	s.kinds["DCGM_FI_PROF_PCIE_RX_BYTES_TOTAL"] = KindCounter
	s.kinds["DCGM_FI_DEV_THERMAL_VIOLATION"] = KindCounter
	var bytes float64
	thermal := 1e9
	for i := 0; i < 10; i++ {
		bytes += 1e6
		if i == 6 {
			thermal = 0
		}
		for metric, value := range map[string]float64{
			"DCGM_FI_PROF_PCIE_RX_BYTES_TOTAL": bytes,
			"DCGM_FI_DEV_THERMAL_VIOLATION":    thermal,
		} {
			key := series{metric: metric, device: device}
			s.points[key] = append(s.points[key], point{at: at(i * 100), value: value})
		}
	}

	traces := s.Trace(at(0), at(900))

	require.Len(t, traces, 1)
	require.Len(t, traces[0].Rows, 10)
	for i := range traces[0].Rows {
		idle := cell(t, traces[0], i, "DCGM_FI_DEV_THERMAL_VIOLATION.rate")
		require.NotNil(t, idle, "row %d", i)
		assert.Zero(t, *idle, "row %d", i)
	}
}

// TestTraceKeepsAMissingReadingOutOfTheAdvances covers a reading the counter
// is absent from. The reading that follows carries no change against it, so
// the counter advances once, shows no period, and its rows stay null.
func TestTraceKeepsAMissingReadingOutOfTheAdvances(t *testing.T) {
	s := NewScraper(nil, 100*time.Millisecond, time.Second)
	device := "node=node0,gpu=0"
	s.devices[device] = map[string]string{"node": "node0", "gpu": "0"}
	s.exporters[device] = ExporterDCGM
	s.kinds["DCGM_FI_PROF_PCIE_RX_BYTES_TOTAL"] = KindCounter
	s.kinds["DCGM_FI_DEV_POWER_VIOLATION"] = KindCounter
	add := func(offsetMs int, metric string, value float64) {
		key := series{metric: metric, device: device}
		s.points[key] = append(s.points[key], point{at: at(offsetMs), value: value})
	}
	var bytes float64
	for i := 0; i < 10; i++ {
		bytes += 1e6
		add(i*100, "DCGM_FI_PROF_PCIE_RX_BYTES_TOTAL", bytes)
		if i == 4 {
			continue
		}
		violation := 5e8
		if i >= 8 {
			violation = 1e9
		}
		add(i*100, "DCGM_FI_DEV_POWER_VIOLATION", violation)
	}

	traces := s.Trace(at(0), at(900))

	require.Len(t, traces, 1)
	require.Len(t, traces[0].Rows, 10)
	for i := range traces[0].Rows {
		assert.Nil(t, cell(t, traces[0], i, "DCGM_FI_DEV_POWER_VIOLATION.rate"), "row %d", i)
	}
}

// TestTraceCapsAShareAtOne covers a torn read, where the active counter
// carries a new refresh and the elapsed counter still the old one. The rig
// showed shares of two hundred times the whole in a few cells per thousand.
func TestTraceCapsAShareAtOne(t *testing.T) {
	s := NewScraper(nil, 100*time.Millisecond, time.Second)
	device := "node=node0,gpu=0"
	s.devices[device] = map[string]string{"node": "node0", "gpu": "0"}
	s.exporters[device] = ExporterDCGM
	s.kinds["DCGM_FI_PROF_SM_CYCLES_ELAPSED_TOTAL"] = KindCounter
	s.kinds["DCGM_FI_PROF_SM_CYCLES_ACTIVE_TOTAL"] = KindCounter
	add := func(offsetMs int, elapsed, active float64) {
		for metric, value := range map[string]float64{"DCGM_FI_PROF_SM_CYCLES_ELAPSED_TOTAL": elapsed, "DCGM_FI_PROF_SM_CYCLES_ACTIVE_TOTAL": active} {
			key := series{metric: metric, device: device}
			s.points[key] = append(s.points[key], point{at: at(offsetMs), value: value})
		}
	}
	add(0, 1000, 800)
	add(100, 2000, 1600)
	add(200, 2010, 2400)

	traces := s.Trace(at(150), at(250))

	require.Len(t, traces, 1)
	require.Len(t, traces[0].Rows, 1)
	assert.EqualValues(t, gaugeScale, *cell(t, traces[0], 0, "DCGM_FI_PROF_SM_CYCLES_ACTIVE_TOTAL.share"))
}

// TestTraceHoldsTheRateDivisorAtOnePoll replays a scrape that overran its tick
// and left the next one two milliseconds behind it. Every refresh advances the
// counter by the same amount, so no row may read faster than one advance over
// one poll.
func TestTraceHoldsTheRateDivisorAtOnePoll(t *testing.T) {
	s := NewScraper(nil, 100*time.Millisecond, time.Second)
	device := "node=node0,gpu=0"
	s.devices[device] = map[string]string{"node": "node0", "gpu": "0"}
	s.exporters[device] = ExporterDCGM
	s.kinds["DCGM_FI_PROF_PCIE_RX_BYTES_TOTAL"] = KindCounter
	value := 0.0
	for _, offset := range []int{274, 374, 474, 687, 689, 775} {
		key := series{metric: "DCGM_FI_PROF_PCIE_RX_BYTES_TOTAL", device: device}
		s.points[key] = append(s.points[key], point{at: at(offset), value: value})
		value += 2.3e8
	}

	traces := s.Trace(at(300), at(800))

	require.Len(t, traces, 1)
	require.Len(t, traces[0].Rows, 5)
	rate := func(row int) *int64 { return cell(t, traces[0], row, "DCGM_FI_PROF_PCIE_RX_BYTES_TOTAL.rate") }
	assert.Nil(t, rate(0), "the first refresh has no base")
	assert.EqualValues(t, 2.3e9, *rate(1))
	assert.Less(t, *rate(2), int64(2.3e9), "an advance spanning 213ms keeps its own span")
	assert.EqualValues(t, 2.3e9, *rate(3), "the catch-up pair divides by one poll")
	assert.EqualValues(t, 2.3e9, *rate(4))
}

func TestTraceReportsNothingOutsideTheBuffer(t *testing.T) {
	assert.Empty(t, tracedScraper().Trace(at(2000), at(3000)))
}

func TestEncodeTracesWritesGzipJSONPerExporter(t *testing.T) {
	traces := tracedScraper().Trace(at(150), at(850))
	traces = append(traces, DeviceTrace{
		Device:   "node=node0",
		Exporter: ExporterNode,
		Labels:   map[string]string{"node": "node0"},
		Rows:     [][]*int64{{measured(50), measured(1200), measured(7e13), measured(1.3e15)}},
	})

	data := encodeTraces(traces)

	reader, err := gzip.NewReader(bytes.NewReader(data))
	require.NoError(t, err)
	raw, err := io.ReadAll(reader)
	require.NoError(t, err)

	var artifact TestArtifact
	require.NoError(t, json.Unmarshal(raw, &artifact))
	assert.Equal(t, 1, artifact.SchemaVersion)
	require.Len(t, artifact.Exporters, 2)

	gpu := artifact.Exporters[ExporterDCGM]
	assert.Equal(t, append([]string{"at_ms"}, traceColumnNames(ExporterDCGM)...), gpu.Columns)
	require.Len(t, gpu.Devices, 1)
	assert.Equal(t, "node=node0,gpu=0", gpu.Devices[0].Key)
	require.Len(t, gpu.Samples, 1)
	assert.Len(t, gpu.Samples[0], 6)
	assert.Len(t, gpu.Samples[0][0], len(gpu.Columns))

	node := artifact.Exporters[ExporterNode]
	assert.Equal(t, []string{"at_ms", "node_cpu_busy_seconds_total.share", "node_memory_MemAvailable_bytes.value", "node_memory_MemTotal_bytes.value"}, node.Columns)
	assert.Len(t, node.Samples[0], 1)
}

func TestFlushHandsEachTestItsTrace(t *testing.T) {
	scraper := tracedScraper()
	collector := NewCollector(scraper)
	var written []string
	collector.TestWriter = func(testFile string, data []byte) {
		reader, err := gzip.NewReader(bytes.NewReader(data))
		require.NoError(t, err)
		_, err = io.ReadAll(reader)
		require.NoError(t, err)
		written = append(written, testFile)
	}

	collector.RecordBlock("a.json", "0x1", at(150), at(850))

	assert.Equal(t, []string{"a.json"}, written)
	assert.Equal(t, 1, collector.Blocks())
}

// TestFlushWritesAnAttemptWithoutRows keeps a failed attempt out of the
// reduced tables while its test still receives the trace.
func TestFlushWritesAnAttemptWithoutRows(t *testing.T) {
	scraper := tracedScraper()
	collector := NewCollector(scraper)
	var written []string
	collector.TestWriter = func(testFile string, _ []byte) {
		written = append(written, testFile)
	}

	collector.RecordAttempt("a.json", "0x1", at(150), at(850))

	assert.Equal(t, []string{"a.json"}, written)
	assert.Equal(t, 0, collector.Blocks())
	assert.Equal(t, 0, collector.Dropped())
	assert.Empty(t, collector.tables)
}

// TestDroppedLeavesAQueuedAttemptOut counts only the proved windows that
// still wait for their samples, since a waiting attempt holds no row to lose.
func TestDroppedLeavesAQueuedAttemptOut(t *testing.T) {
	collector := NewCollector(tracedScraper())
	now := time.Now()

	collector.RecordAttempt("a.json", "0x1", now.Add(-100*time.Millisecond), now)
	assert.Zero(t, collector.Dropped())

	collector.RecordBlock("b.json", "0x2", now.Add(-100*time.Millisecond), now)
	assert.Equal(t, 1, collector.Dropped())
}

// TestTraceColumnsUseRecordedMetrics keeps every traced metric among the
// series the scraper buffers. A column over a metric nothing records would be
// null in every row.
func TestTraceColumnsUseRecordedMetrics(t *testing.T) {
	for exporter, columns := range traceColumns {
		for _, column := range columns {
			assert.Contains(t, artifactColumns[exporter], column.metric, exporter)
			if column.stat == "share" {
				assert.Contains(t, artifactColumns[exporter], column.reference, exporter)
			} else {
				assert.Empty(t, column.reference, "%s %s names a reference it does not use", exporter, column.name())
			}
		}
	}
}

// TestTraceCarriesOnlyTheColumnsTheTestModalReads keeps the per test
// artifact and the modal in step, the same way the run level artifact is kept
// in step with the run page.
func TestTraceCarriesOnlyTheColumnsTheTestModalReads(t *testing.T) {
	source, err := os.ReadFile(filepath.Join("..", "..", "ui", "src", "utils", "testMetrics.ts"))
	require.NoError(t, err)

	read := map[string]struct{}{}
	for _, column := range regexp.MustCompile(`(?:DCGM_FI_[A-Z0-9_]+|node_[A-Za-z0-9_]+)\.(?:share|rate|value)`).FindAllString(string(source), -1) {
		read[column] = struct{}{}
	}

	written := map[string]struct{}{}
	for exporter := range traceColumns {
		for _, name := range traceColumnNames(exporter) {
			written[name] = struct{}{}
		}
	}

	assert.Equal(t, written, read)
}

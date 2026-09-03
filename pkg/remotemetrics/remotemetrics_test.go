package remotemetrics

import (
	"context"
	"encoding/json"
	"math"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"regexp"
	"strconv"
	"sync/atomic"
	"testing"
	"time"

	dto "github.com/prometheus/client_model/go"
	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"
	"google.golang.org/protobuf/proto"
)

// base is an arbitrary fixed instant, so a window is described by offsets.
var base = time.Date(2026, 9, 1, 12, 0, 0, 0, time.UTC)

func at(offsetMs int) time.Time {
	return base.Add(time.Duration(offsetMs) * time.Millisecond)
}

func points(values ...float64) []point {
	out := make([]point, 0, len(values))
	for i, value := range values {
		out = append(out, point{at: at(i * 100), value: value})
	}
	return out
}

func TestCounterTotalInterpolatesBothEdges(t *testing.T) {
	// A counter rising by 100 every 100ms, sampled at 0, 100, 200, 300.
	series := points(0, 100, 200, 300)

	tests := []struct {
		name       string
		start, end time.Time
		want       float64
	}{
		{"whole span", at(0), at(300), 300},
		{"aligned inner window", at(100), at(200), 100},
		{"half sample either side", at(50), at(250), 200},
		{"inside one interval", at(120), at(180), 60},
	}
	for _, tc := range tests {
		t.Run(tc.name, func(t *testing.T) {
			got, ok := counterTotal(series, tc.start, tc.end)
			require.True(t, ok)
			assert.InDelta(t, tc.want, got, 0.001)
		})
	}
}

// TestCounterResetIsRejected covers a host engine or exporter restart. The
// counter returns to zero, so any subtraction across that point is meaningless
// and must be dropped rather than reported.
func TestCounterResetIsRejected(t *testing.T) {
	_, ok := counterTotal(points(100, 200, 5, 10), at(0), at(300))
	assert.False(t, ok, "a falling counter must not produce a total")
}

// TestWindowOutsideTheSamplesIsRejected keeps a window from reporting a total
// that covers less time than it claims.
func TestWindowOutsideTheSamplesIsRejected(t *testing.T) {
	series := points(0, 100, 200)
	assert.False(t, covers(series, at(-500), at(100)), "window starts before the first sample")
	assert.False(t, covers(series, at(0), at(900)), "window ends after the last sample")
	assert.True(t, covers(series, at(0), at(200)))
}

func TestGaugeKeepsBothTails(t *testing.T) {
	// Min matters as much as max, because a headroom gauge is alarming when
	// it is small.
	stat, count, ok := gaugeStat(points(0.5, 0.1, 0.9, 0.3), at(0), at(300))
	require.True(t, ok)
	assert.Equal(t, 4, count)
	assert.InDelta(t, 0.45, stat.Mean, 0.001)
	assert.InDelta(t, 0.1, stat.Min, 0.001)
	assert.InDelta(t, 0.9, stat.Max, 0.001)
}

// TestUpdatesCountsSourceRefreshesNotScrapes is the in-band resolution meter.
// DCGM can drop its profiling refresh to 1 Hz while the scraper still polls at
// 10 Hz, and the repeated rows are identical, so only counting value changes
// reveals it.
func TestUpdatesCountsSourceRefreshesNotScrapes(t *testing.T) {
	// Ten scrapes, but the source only advanced twice.
	stale := points(10, 10, 10, 10, 10, 20, 20, 20, 20, 30)
	scrapes, updates := activity(stale, at(0), at(900))
	assert.Equal(t, 10, scrapes, "every reading counts as a scrape")
	assert.Equal(t, 2, updates, "only a changed value counts as a refresh")

	healthy := points(10, 20, 30, 40, 50)
	scrapes, updates = activity(healthy, at(0), at(400))
	assert.Equal(t, 5, scrapes)
	assert.Equal(t, 4, updates)
}

// exposition is the shape the GPU sidecar serves, trimmed to three series.
const exposition = `# HELP DCGM_FI_PROF_SM_CYCLES_ELAPSED_TOTAL SM cycles elapsed
# TYPE DCGM_FI_PROF_SM_CYCLES_ELAPSED_TOTAL counter
DCGM_FI_PROF_SM_CYCLES_ELAPSED_TOTAL{gpu="0",UUID="GPU-aaa"} 1000
DCGM_FI_PROF_SM_CYCLES_ELAPSED_TOTAL{gpu="1",UUID="GPU-bbb"} 2000
# HELP DCGM_FI_PROF_DRAM_ACTIVE dram active
# TYPE DCGM_FI_PROF_DRAM_ACTIVE gauge
DCGM_FI_PROF_DRAM_ACTIVE{gpu="0",UUID="GPU-aaa"} 0.25
DCGM_FI_PROF_DRAM_ACTIVE{gpu="1",UUID="GPU-bbb"} 0.75
`

// TestScrapeLearnsKindsFromTheExposition covers how a series learns whether it
// subtracts or averages. The TYPE line decides the kind, not the field name.
func TestScrapeLearnsKindsFromTheExposition(t *testing.T) {
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		w.Header().Set("Content-Type", "text/plain; version=0.0.4")
		_, _ = w.Write([]byte(exposition))
	}))
	defer server.Close()

	scraper := NewScraper([]Endpoint{{
		Exporter: ExporterDCGM,
		URL:      server.URL,
		Labels:   map[string]string{"node": "node0"},
	}}, 10*time.Millisecond, time.Second)

	require.NoError(t, scraper.scrape(context.Background(), scraper.endpoints[0]))

	assert.Equal(t, KindCounter, scraper.kinds["DCGM_FI_PROF_SM_CYCLES_ELAPSED_TOTAL"])
	assert.Equal(t, KindGauge, scraper.kinds["DCGM_FI_PROF_DRAM_ACTIVE"])
	assert.Len(t, scraper.devices, 2, "each gpu is its own device")

	for device, labels := range scraper.devices {
		assert.Equal(t, "node0", labels["node"], "device %s lost its endpoint label", device)
		assert.Contains(t, labels, "gpu")
	}
}

// TestReduceProducesOneRowPerDevice covers the whole path from an exposition
// to the reduced window a run stores.
func TestReduceProducesOneRowPerDevice(t *testing.T) {
	var cycles float64 = 1000
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		cycles += 500
		w.Header().Set("Content-Type", "text/plain; version=0.0.4")
		_, _ = w.Write([]byte(
			"# TYPE DCGM_FI_PROF_SM_CYCLES_ELAPSED_TOTAL counter\nDCGM_FI_PROF_SM_CYCLES_ELAPSED_TOTAL{gpu=\"0\"} " + formatFloat(cycles) + "\n" +
				"# TYPE DCGM_FI_PROF_DRAM_ACTIVE gauge\nDCGM_FI_PROF_DRAM_ACTIVE{gpu=\"0\"} 0.5\n"))
	}))
	defer server.Close()

	scraper := NewScraper([]Endpoint{{Exporter: ExporterDCGM, URL: server.URL, Labels: map[string]string{"node": "node0"}}}, 20*time.Millisecond, time.Second)
	ctx, cancel := context.WithCancel(context.Background())
	go scraper.Run(ctx)

	time.Sleep(300 * time.Millisecond)
	start := time.Now().Add(-200 * time.Millisecond)
	end := time.Now().Add(-50 * time.Millisecond)
	cancel()

	windows := scraper.Reduce(start, end)
	require.Len(t, windows, 1)

	window := windows[0]
	assert.Positive(t, window.Metrics["DCGM_FI_PROF_SM_CYCLES_ELAPSED_TOTAL"].Total, "the counter advanced during the window")
	assert.InDelta(t, 0.5, window.Metrics["DCGM_FI_PROF_DRAM_ACTIVE"].Mean, 0.001)
	assert.Positive(t, window.Scrapes)
	assert.Positive(t, window.Updates)
}

// TestRecordBlockAtProductionTiming reproduces how the executor calls the
// collector. The window ends at the instant the RPC returned, which is always
// later than the newest sample, so a collector that only reduces what it holds
// at that moment records nothing.
func TestRecordBlockAtProductionTiming(t *testing.T) {
	var cycles float64
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		cycles += 100
		w.Header().Set("Content-Type", "text/plain; version=0.0.4")
		_, _ = w.Write([]byte("# TYPE DCGM_FI_PROF_SM_CYCLES_ELAPSED_TOTAL counter\nDCGM_FI_PROF_SM_CYCLES_ELAPSED_TOTAL{gpu=\"0\"} " + formatFloat(cycles) + "\n"))
	}))
	defer server.Close()

	scraper := NewScraper([]Endpoint{{Exporter: ExporterDCGM, URL: server.URL, Labels: map[string]string{"node": "node0"}}}, 50*time.Millisecond, time.Second)
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()

	go scraper.Run(ctx)
	time.Sleep(500 * time.Millisecond)

	collector := NewCollector(scraper)
	// The executor records the block the moment the call returns, with no
	// pause for the scraper to catch up.
	start := time.Now().Add(-200 * time.Millisecond)
	collector.RecordBlock("test.json", "0xabc", start, time.Now())

	// The window cannot be reduced yet, so it must be held rather than lost.
	assert.Zero(t, collector.dropped, "the window was discarded instead of queued")

	// Once the samples catch up, as they do while later blocks run, the
	// queued window resolves.
	time.Sleep(300 * time.Millisecond)
	assert.Equal(t, 1, collector.Blocks(), "a block recorded at production timing was dropped")
	assert.Zero(t, collector.Dropped())
}

func TestCollectorSkipsAnEmptyWindow(t *testing.T) {
	collector := NewCollector(NewScraper(nil, time.Second, time.Second))
	collector.RecordBlock("test.json", "0xabc", time.Now(), time.Now().Add(-time.Second))
	assert.Zero(t, collector.Blocks(), "a window that ends before it starts is not a block")
}

// TestWriteSkipsAnEmptyRun keeps an artifact of zeroes out of the results,
// where it would read as a GPU that did no work rather than as absent
// telemetry.
func TestWriteSkipsAnEmptyRun(t *testing.T) {
	collector := NewCollector(NewScraper(nil, time.Second, time.Second))
	paths, err := collector.Write(t.TempDir())
	require.NoError(t, err)
	assert.Empty(t, paths, "an empty run must write no artifact")
}

// TestArtifactListsEachDeviceOnce covers the shape a run stores. Repeating the
// label set on every block of every device would dominate the file.
func TestArtifactListsEachDeviceOnce(t *testing.T) {
	scraper := NewScraper([]Endpoint{{Exporter: ExporterDCGM}}, time.Second, time.Second)
	now := time.Now()
	for i := range 4 {
		at := now.Add(time.Duration(i) * 100 * time.Millisecond)
		scraper.points[series{metric: "DCGM_FI_PROF_SM_CYCLES_ELAPSED_TOTAL", device: "node=node0,gpu=0"}] = append(
			scraper.points[series{metric: "DCGM_FI_PROF_SM_CYCLES_ELAPSED_TOTAL", device: "node=node0,gpu=0"}],
			point{at: at, value: float64(i * 150)})
	}
	scraper.kinds["DCGM_FI_PROF_SM_CYCLES_ELAPSED_TOTAL"] = KindCounter
	scraper.devices["node=node0,gpu=0"] = map[string]string{"node": "node0", "gpu": "0"}
	scraper.exporters["node=node0,gpu=0"] = ExporterDCGM

	collector := NewCollector(scraper)
	collector.RecordBlock("a.json", "0x1", now, now.Add(200*time.Millisecond))
	collector.RecordBlock("a.json", "0x2", now.Add(100*time.Millisecond), now.Add(300*time.Millisecond))
	require.Equal(t, 2, collector.Blocks())

	dir := t.TempDir()
	_, err := collector.Write(dir)
	require.NoError(t, err)

	data, err := os.ReadFile(filepath.Join(dir, ArtifactNames[ExporterDCGM]))
	require.NoError(t, err)

	var artifact Artifact
	require.NoError(t, json.Unmarshal(data, &artifact))
	assert.Equal(t, schemaVersion, artifact.SchemaVersion)
	require.Len(t, artifact.Devices, 1, "one device listed once")
	assert.Equal(t, "node0", artifact.Devices[0].Labels["node"])
	require.Len(t, artifact.Tests["a.json"], 2, "both blocks kept")
	assert.Equal(t,
		[]string{"device", "scrapes", "updates", "duration_ms", "DCGM_FI_PROF_SM_CYCLES_ELAPSED_TOTAL.total"},
		artifact.Columns)

	row := artifact.Tests["a.json"]["0x1"][0]
	require.Len(t, row, len(artifact.Columns), "a row carries one value per column")
	require.NotNil(t, row[0])
	assert.Equal(t, int64(0), *row[0], "rows reference the device table")
	require.NotNil(t, row[3])
	assert.Equal(t, int64(200), *row[3], "the window duration lands in its column")
	require.NotNil(t, row[4])
	assert.Equal(t, int64(300), *row[4], "the counter total lands in its column")
}

// TestArtifactCarriesOnlyTheStatisticsTheResultsPageReads keeps the artifact
// from carrying a column nothing renders. Every statistic the page names must
// be written, and every statistic written must be named by the page.
func TestArtifactCarriesOnlyTheStatisticsTheResultsPageReads(t *testing.T) {
	pattern := regexp.MustCompile(`(?:DCGM_FI_[A-Z0-9_]+|node_[A-Za-z0-9_]+)\.(?:total|rate_max|mean|min|max)`)

	for exporter, file := range map[string]string{ExporterDCGM: "gpuMetrics.ts", ExporterNode: "nodeMetrics.ts"} {
		source, err := os.ReadFile(filepath.Join("..", "..", "ui", "src", "utils", file))
		require.NoError(t, err)

		read := map[string]struct{}{}
		for _, column := range pattern.FindAllString(string(source), -1) {
			read[column] = struct{}{}
		}

		written := map[string]struct{}{}
		for metric, stats := range artifactColumns[exporter] {
			for _, stat := range stats {
				written[metric+"."+stat] = struct{}{}
			}
		}

		assert.Equal(t, read, written, exporter)
	}
}

// TestNodePresetRecordsExactlyTheArtifactColumns keeps the series the node
// preset produces and the columns the artifact carries in step, since one is
// keyed by exposition family and the other by series name.
func TestNodePresetRecordsExactlyTheArtifactColumns(t *testing.T) {
	produced := map[string]struct{}{}
	for _, selections := range nodeExporterPreset.series {
		for _, sel := range selections {
			produced[sel.name] = struct{}{}
		}
	}

	listed := map[string]struct{}{}
	for metric := range artifactColumns[ExporterNode] {
		listed[metric] = struct{}{}
	}

	assert.Equal(t, listed, produced)
}

// nodeExposition is the shape the node sidecar serves, trimmed to two cores.
// The busy modes carry one second each so the sum is countable, and idle
// carries a large value that must reach the all modes series only.
const nodeExposition = `# TYPE node_cpu_seconds_total counter
node_cpu_seconds_total{cpu="0",mode="user"} 1
node_cpu_seconds_total{cpu="0",mode="system"} 1
node_cpu_seconds_total{cpu="0",mode="idle"} 1000
node_cpu_seconds_total{cpu="0",mode="iowait"} 500
node_cpu_seconds_total{cpu="1",mode="user"} 1
node_cpu_seconds_total{cpu="1",mode="system"} 1
node_cpu_seconds_total{cpu="1",mode="idle"} 1000
# TYPE node_memory_MemTotal_bytes gauge
node_memory_MemTotal_bytes 6.7149443072e+10
# TYPE node_memory_MemAvailable_bytes gauge
node_memory_MemAvailable_bytes 3.9e+10
# TYPE node_filesystem_size_bytes gauge
node_filesystem_size_bytes{device="/dev/nvme0n1",mountpoint="/"} 999
`

// TestSelectionRefusesASampleMissingTheFilteredLabel keeps a sample with no
// mode label out of the busy series, where it would otherwise count as busy.
func TestSelectionRefusesASampleMissingTheFilteredLabel(t *testing.T) {
	busy := nodeExporterPreset.series["node_cpu_seconds_total"][1]
	require.Equal(t, "node_cpu_busy_seconds_total", busy.name)

	labelled := &dto.Metric{Label: []*dto.LabelPair{{Name: proto.String("cpu"), Value: proto.String("0")}, {Name: proto.String("mode"), Value: proto.String("user")}}}
	assert.True(t, busy.matches(labelled))

	unlabelled := &dto.Metric{Label: []*dto.LabelPair{{Name: proto.String("cpu"), Value: proto.String("0")}}}
	assert.False(t, busy.matches(unlabelled), "a sample without a mode is not busy time")
}

// TestNodeExporterPresetCollapsesToOneDevice is what makes a node exporter
// usable here. Every core would otherwise become its own device, and the
// artifact holds one row per device per block.
func TestNodeExporterPresetCollapsesToOneDevice(t *testing.T) {
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		w.Header().Set("Content-Type", "text/plain; version=0.0.4")
		_, _ = w.Write([]byte(nodeExposition))
	}))
	defer server.Close()

	scraper := NewScraper([]Endpoint{{
		Exporter: ExporterNode,
		URL:      server.URL,
		Labels:   map[string]string{"node": "node1"},
	}}, time.Second, time.Second)
	require.NoError(t, scraper.scrape(context.Background(), scraper.endpoints[0]))

	require.Len(t, scraper.devices, 1, "the node must be one device, not one per core")
	assert.Equal(t, map[string]string{"node": "node1"}, scraper.devices["node=node1"])
	assert.Equal(t, ExporterNode, scraper.exporters["node=node1"])

	all := scraper.points[series{metric: "node_cpu_seconds_total", device: "node=node1"}]
	require.Len(t, all, 1, "one reading per series per scrape")
	assert.InDelta(t, 2504, all[0].value, 0.001, "every mode across both cores")

	busy := scraper.points[series{metric: "node_cpu_busy_seconds_total", device: "node=node1"}]
	require.Len(t, busy, 1)
	assert.InDelta(t, 4, busy[0].value, 0.001, "idle and iowait stay out of busy")
	assert.Equal(t, KindCounter, scraper.kinds["node_cpu_busy_seconds_total"])

	memory := scraper.points[series{metric: "node_memory_MemTotal_bytes", device: "node=node1"}]
	require.Len(t, memory, 1)
	assert.InDelta(t, 6.7149443072e10, memory[0].value, 1)

	for key := range scraper.points {
		assert.NotEqual(t, "node_filesystem_size_bytes", key.metric, "a metric outside the preset was recorded")
	}
}

// TestEachExporterWritesItsOwnFile keeps GPU rows and node rows apart. One
// table would pad every GPU row with the node columns and every node row with
// the GPU columns, on every block of a run.
func TestEachExporterWritesItsOwnFile(t *testing.T) {
	scraper := NewScraper(nil, time.Second, time.Second)
	now := time.Now()
	for device, exporter := range map[string]string{"node=node0,gpu=0": ExporterDCGM, "node=node0": ExporterNode} {
		metric := "DCGM_FI_PROF_SM_CYCLES_ELAPSED_TOTAL"
		if exporter == ExporterNode {
			metric = "node_cpu_busy_seconds_total"
		}
		key := series{metric: metric, device: device}
		for i := range 4 {
			scraper.points[key] = append(scraper.points[key],
				point{at: now.Add(time.Duration(i) * 100 * time.Millisecond), value: float64(i * 100)})
		}
		scraper.kinds[metric] = KindCounter
		scraper.devices[device] = map[string]string{"node": "node0"}
		scraper.exporters[device] = exporter
	}

	collector := NewCollector(scraper)
	collector.RecordBlock("a.json", "0x1", now, now.Add(200*time.Millisecond))
	require.Equal(t, 1, collector.Blocks(), "one block, whichever exporters reported it")

	dir := t.TempDir()
	paths, err := collector.Write(dir)
	require.NoError(t, err)
	assert.ElementsMatch(t, []string{
		filepath.Join(dir, ArtifactNames[ExporterDCGM]),
		filepath.Join(dir, ArtifactNames[ExporterNode]),
	}, paths)

	data, err := os.ReadFile(filepath.Join(dir, ArtifactNames[ExporterNode]))
	require.NoError(t, err)
	var artifact Artifact
	require.NoError(t, json.Unmarshal(data, &artifact))
	assert.Equal(t, []string{"device", "scrapes", "updates", "duration_ms", "node_cpu_busy_seconds_total.total"}, artifact.Columns)
	require.Len(t, artifact.Devices, 1)
	assert.Equal(t, "node=node0", artifact.Devices[0].Key)
}

// TestRowWritesOnlyTheListedStatistics keeps an unlisted statistic out of the
// row. A gauge reduces to three numbers, and a page that reads two of them
// must not pay for the third on every device of every block.
func TestRowWritesOnlyTheListedStatistics(t *testing.T) {
	scraper := NewScraper([]Endpoint{{Exporter: ExporterDCGM}}, time.Second, time.Second)
	now := time.Now()
	key := series{metric: "DCGM_FI_DEV_POWER_USAGE", device: "node=node0,gpu=0"}
	for i, watts := range []float64{100, 200, 300} {
		scraper.points[key] = append(scraper.points[key],
			point{at: now.Add(time.Duration(i) * 100 * time.Millisecond), value: watts})
	}
	scraper.kinds["DCGM_FI_DEV_POWER_USAGE"] = KindGauge
	scraper.devices["node=node0,gpu=0"] = map[string]string{"node": "node0"}
	scraper.exporters["node=node0,gpu=0"] = ExporterDCGM

	collector := NewCollector(scraper)
	collector.RecordBlock("a.json", "0x1", now, now.Add(200*time.Millisecond))
	require.Equal(t, 1, collector.Blocks())

	assert.Equal(t, []string{"DCGM_FI_DEV_POWER_USAGE.mean", "DCGM_FI_DEV_POWER_USAGE.max"},
		collector.tables[ExporterDCGM].columns, "the minimum is read by nothing and must not be written")

	row := collector.tables[ExporterDCGM].tests["a.json"]["0x1"][0]
	require.NotNil(t, row[4])
	assert.Equal(t, int64(200*gaugeScale), *row[4])
	require.NotNil(t, row[5])
	assert.Equal(t, int64(300*gaugeScale), *row[5])
}

// TestStatisticRefusesTheOtherKind guards against an exporter that declares a
// listed counter as a gauge. Its total would otherwise be written as a zero,
// which reads as a device that did no work.
func TestStatisticRefusesTheOtherKind(t *testing.T) {
	_, _, ok := statistic(Stat{Total: 5}, KindGauge, "total")
	assert.False(t, ok)

	_, _, ok = statistic(Stat{Mean: 5}, KindCounter, "mean")
	assert.False(t, ok)
}

// TestScrapeDropsAMetricOutsideTheArtifact keeps the buffer as small as the
// artifact. A field nothing writes has no reason to be held for fifteen
// minutes on every device.
func TestScrapeDropsAMetricOutsideTheArtifact(t *testing.T) {
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		w.Header().Set("Content-Type", "text/plain; version=0.0.4")
		_, _ = w.Write([]byte(
			"# TYPE DCGM_FI_DEV_CLOCKS_EVENT_REASONS gauge\nDCGM_FI_DEV_CLOCKS_EVENT_REASONS{gpu=\"0\"} 4\n" +
				"# TYPE DCGM_FI_PROF_DRAM_ACTIVE gauge\nDCGM_FI_PROF_DRAM_ACTIVE{gpu=\"0\"} 0.5\n"))
	}))
	defer server.Close()

	scraper := NewScraper([]Endpoint{{Exporter: ExporterDCGM, URL: server.URL, Labels: map[string]string{"node": "node0"}}}, time.Second, time.Second)
	require.NoError(t, scraper.scrape(context.Background(), scraper.endpoints[0]))

	assert.Empty(t, scraper.points[series{metric: "DCGM_FI_DEV_CLOCKS_EVENT_REASONS", device: "node=node0,gpu=0"}],
		"a metric outside the artifact was buffered")
	assert.Len(t, scraper.points[series{metric: "DCGM_FI_PROF_DRAM_ACTIVE", device: "node=node0,gpu=0"}], 1)
}

// TestCounterResetOutsideTheWindowIsIgnored covers an exporter restart earlier
// in the run. The buffer holds fifteen minutes, so a reset that poisoned every
// window still holding it would cost hundreds of blocks rather than the one
// block it actually spans.
func TestCounterResetOutsideTheWindowIsIgnored(t *testing.T) {
	// A reset between the first two readings, then a clean rise.
	series := points(500, 10, 110, 210, 310, 410)

	stat, count, _, ok := reduce(series, KindCounter, at(300), at(500), 100*time.Millisecond)
	require.True(t, ok, "a reset before the window must not reject it")
	assert.InDelta(t, 200, stat.Total, 0.001)
	assert.Equal(t, 3, count)

	_, _, _, ok = reduce(series, KindCounter, at(0), at(300), 100*time.Millisecond)
	assert.False(t, ok, "a reset inside the window still rejects it")
}

// TestGapLimitFollowsTheWindow keeps a brief stall from discarding a long
// proof, while an outage still discards a short one. A ten minute block and a
// two second block cannot share a fixed tolerance.
func TestGapLimitFollowsTheWindow(t *testing.T) {
	const interval = 100 * time.Millisecond

	assert.Equal(t, 500*time.Millisecond, gapLimit(at(0), at(1000), interval),
		"a short window uses the poll rate")
	assert.Equal(t, 2*time.Minute, gapLimit(at(0), at(600000), interval),
		"a ten minute window tolerates proportionally more")

	// A minute of steady scraping with one 600ms stall in the middle. The
	// stall is jitter against a window this long, not an outage.
	var long []point
	for offset := 0; offset <= 60000; offset += 100 {
		if offset > 30000 && offset < 30600 {
			continue
		}

		long = append(long, point{at: at(offset), value: float64(offset)})
	}

	_, _, _, ok := reduce(long, KindCounter, at(100), at(59000), interval)
	assert.True(t, ok, "a long window was discarded over a moment of jitter")

	// The same stall dominates a two second window, so that one is rejected.
	_, _, _, ok = reduce(long, KindCounter, at(29500), at(31500), interval)
	assert.False(t, ok, "a stall covering a third of a short window was kept")
}

// TestWindowRestingOnAGapIsRejected covers an endpoint that went unreachable.
// Interpolating across the hole would report work in proportion to the gap,
// which no reading ever measured.
func TestWindowRestingOnAGapIsRejected(t *testing.T) {
	series := []point{
		{at: at(0), value: 1000},
		{at: at(120000), value: 121000},
	}

	_, _, _, ok := reduce(series, KindCounter, at(30000), at(60000), 100*time.Millisecond)
	assert.False(t, ok, "a window with no reading inside it must not be interpolated")

	// The same shape within the tolerance still reduces, so a block shorter
	// than one scrape interval is not thrown away.
	tight := []point{
		{at: at(0), value: 1000},
		{at: at(100), value: 1100},
	}
	_, _, _, ok = reduce(tight, KindCounter, at(20), at(80), 100*time.Millisecond)
	assert.True(t, ok, "a normal gap between readings must still reduce")
}

// TestNonFiniteSamplesAreRefused keeps a blanked field out of the buffer. NaN
// compares false against everything, so it would slip past the counter reset
// guard and reduce into a statistic nothing downstream could recognise.
func TestNonFiniteSamplesAreRefused(t *testing.T) {
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		w.Header().Set("Content-Type", "text/plain; version=0.0.4")
		_, _ = w.Write([]byte(
			"# TYPE DCGM_FI_PROF_SM_CYCLES_ELAPSED_TOTAL counter\nDCGM_FI_PROF_SM_CYCLES_ELAPSED_TOTAL{gpu=\"0\"} NaN\n" +
				"# TYPE DCGM_FI_PROF_DRAM_ACTIVE gauge\nDCGM_FI_PROF_DRAM_ACTIVE{gpu=\"0\"} +Inf\n" +
				"# TYPE DCGM_FI_PROF_SM_OCCUPANCY gauge\nDCGM_FI_PROF_SM_OCCUPANCY{gpu=\"0\"} 0.5\n"))
	}))
	defer server.Close()

	scraper := NewScraper([]Endpoint{{Exporter: ExporterDCGM, URL: server.URL, Labels: map[string]string{"node": "node0"}}}, time.Second, time.Second)
	require.NoError(t, scraper.scrape(context.Background(), scraper.endpoints[0]))

	assert.Empty(t, scraper.points[series{metric: "DCGM_FI_PROF_SM_CYCLES_ELAPSED_TOTAL", device: "node=node0,gpu=0"}], "NaN was stored")
	assert.Empty(t, scraper.points[series{metric: "DCGM_FI_PROF_DRAM_ACTIVE", device: "node=node0,gpu=0"}], "Inf was stored")
	assert.Len(t, scraper.points[series{metric: "DCGM_FI_PROF_SM_OCCUPANCY", device: "node=node0,gpu=0"}], 1,
		"a healthy sample beside a bad one must survive")
}

// TestUnmeasuredMetricIsNotAZero is the difference between a GPU that did no
// work and a GPU nothing observed. Both would otherwise be a row of zeroes.
func TestUnmeasuredMetricIsNotAZero(t *testing.T) {
	scraper := NewScraper([]Endpoint{{Exporter: ExporterDCGM}}, time.Second, time.Second)
	now := time.Now()
	key := series{metric: "DCGM_FI_PROF_SM_CYCLES_ELAPSED_TOTAL", device: "node=node0,gpu=0"}
	for i := range 4 {
		scraper.points[key] = append(scraper.points[key],
			point{at: now.Add(time.Duration(i) * 100 * time.Millisecond), value: float64(i * 100)})
	}
	scraper.kinds["DCGM_FI_PROF_SM_CYCLES_ELAPSED_TOTAL"] = KindCounter
	scraper.kinds["DCGM_FI_PROF_SM_CYCLES_ACTIVE_TOTAL"] = KindCounter
	scraper.devices["node=node0,gpu=0"] = map[string]string{"node": "node0"}
	scraper.exporters["node=node0,gpu=0"] = ExporterDCGM

	collector := NewCollector(scraper)
	collector.RecordBlock("a.json", "0x1", now, now.Add(200*time.Millisecond))
	require.Equal(t, 1, collector.Blocks())

	// A column that appears only later leaves the earlier row short, and the
	// padding must not read as a measurement.
	collector.table(ExporterDCGM).columnIndex("DCGM_FI_PROF_SM_CYCLES_ACTIVE_TOTAL", "total")

	dir := t.TempDir()
	_, err := collector.Write(dir)
	require.NoError(t, err)

	data, err := os.ReadFile(filepath.Join(dir, ArtifactNames[ExporterDCGM]))
	require.NoError(t, err)

	var artifact Artifact
	require.NoError(t, json.Unmarshal(data, &artifact))

	row := artifact.Tests["a.json"]["0x1"][0]
	require.Len(t, row, len(artifact.Columns))
	require.NotNil(t, row[4])
	assert.Equal(t, int64(200), *row[4], "the measured counter keeps its value")
	assert.Nil(t, row[5], "an unmeasured column is null, not zero")
}

// TestQuantiseRefusesWhatInt64CannotHold keeps a sentinel or an overflowing
// scale from landing in the artifact as a real number.
func TestQuantiseRefusesWhatInt64CannotHold(t *testing.T) {
	require.NotNil(t, quantise(0.5, gaugeScale))
	assert.Equal(t, int64(5000), *quantise(0.5, gaugeScale))
	assert.Nil(t, quantise(math.NaN(), 1))
	assert.Nil(t, quantise(math.Inf(1), 1))
	assert.Nil(t, quantise(9.0e18, gaugeScale))
}

// TestStalledEndpointDoesNotStarveOthers covers one unreachable node on a rig
// of four. Polled in turn, the dead host would spend its whole timeout before
// the next was dialled and every node would lose resolution.
func TestStalledEndpointDoesNotStarveOthers(t *testing.T) {
	block := make(chan struct{})

	stalled := httptest.NewServer(http.HandlerFunc(func(_ http.ResponseWriter, _ *http.Request) {
		<-block
	}))
	// Closing the server waits for its handlers, so release them first.
	defer stalled.Close()
	defer close(block)

	var served atomic.Int64
	healthy := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		served.Add(1)
		w.Header().Set("Content-Type", "text/plain; version=0.0.4")
		_, _ = w.Write([]byte("# TYPE DCGM_FI_PROF_SM_CYCLES_ELAPSED_TOTAL counter\nDCGM_FI_PROF_SM_CYCLES_ELAPSED_TOTAL{gpu=\"0\"} 1\n"))
	}))
	defer healthy.Close()

	scraper := NewScraper([]Endpoint{
		{Exporter: ExporterDCGM, URL: stalled.URL, Labels: map[string]string{"node": "stalled"}},
		{Exporter: ExporterDCGM, URL: healthy.URL, Labels: map[string]string{"node": "healthy"}},
	}, 20*time.Millisecond, 5*time.Second)

	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()

	go scraper.Run(ctx)
	time.Sleep(400 * time.Millisecond)

	// Serial scraping would cap the healthy endpoint at one reading per
	// timeout, so anything above a handful proves the endpoints run together.
	assert.Greater(t, served.Load(), int64(5),
		"the healthy endpoint was throttled by the stalled one")
}

// TestFailuresNameTheEndpoint covers the log a run leaves when an artifact is
// missing. A count alone cannot say which endpoint never answered.
func TestFailuresNameTheEndpoint(t *testing.T) {
	broken := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		w.WriteHeader(http.StatusServiceUnavailable)
	}))
	defer broken.Close()

	healthy := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		w.Header().Set("Content-Type", "text/plain; version=0.0.4")
		_, _ = w.Write([]byte("# TYPE DCGM_FI_PROF_SM_CYCLES_ELAPSED_TOTAL counter\nDCGM_FI_PROF_SM_CYCLES_ELAPSED_TOTAL{gpu=\"0\"} 1\n"))
	}))
	defer healthy.Close()

	scraper := NewScraper([]Endpoint{
		{Exporter: ExporterDCGM, URL: healthy.URL, Labels: map[string]string{"node": "node0"}},
		{Exporter: ExporterNode, URL: broken.URL, Labels: map[string]string{"node": "node0"}},
	}, 20*time.Millisecond, time.Second)

	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()

	go scraper.Run(ctx)
	time.Sleep(200 * time.Millisecond)

	failures := scraper.Failures()
	require.Len(t, failures, 1, "only the broken endpoint fails")
	assert.Greater(t, failures[broken.URL].Count, 2)
	assert.ErrorContains(t, failures[broken.URL].Last, "503")
}

// TestWrongServiceOnThePortIsAFailure covers a port held by another exporter.
// It answers 200 with metrics of its own, so without this check a run ends
// with no artifact and no word about why.
func TestWrongServiceOnThePortIsAFailure(t *testing.T) {
	other := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		w.Header().Set("Content-Type", "text/plain; version=0.0.4")
		_, _ = w.Write([]byte("# TYPE haproxy_up gauge\nhaproxy_up 1\n"))
	}))
	defer other.Close()

	scraper := NewScraper([]Endpoint{{Exporter: ExporterNode, URL: other.URL, Labels: map[string]string{"node": "node0"}}}, time.Second, time.Second)
	err := scraper.scrape(context.Background(), Endpoint{Exporter: ExporterNode, URL: other.URL, Labels: map[string]string{"node": "node0"}})

	require.ErrorContains(t, err, "serves none of the node-exporter series")
	assert.Empty(t, scraper.points)
}

// TestSettleKeepsTheFinalBlock covers the last block of a run. Nothing arrives
// after it to carry its window, so without a wait it would be dropped.
func TestSettleKeepsTheFinalBlock(t *testing.T) {
	var cycles float64
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		cycles += 100
		w.Header().Set("Content-Type", "text/plain; version=0.0.4")
		_, _ = w.Write([]byte("# TYPE DCGM_FI_PROF_SM_CYCLES_ELAPSED_TOTAL counter\nDCGM_FI_PROF_SM_CYCLES_ELAPSED_TOTAL{gpu=\"0\"} " + formatFloat(cycles) + "\n"))
	}))
	defer server.Close()

	scraper := NewScraper([]Endpoint{{Exporter: ExporterDCGM, URL: server.URL, Labels: map[string]string{"node": "node0"}}}, 50*time.Millisecond, time.Second)
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()

	go scraper.Run(ctx)
	time.Sleep(300 * time.Millisecond)

	collector := NewCollector(scraper)
	collector.RecordBlock("test.json", "0xlast", time.Now().Add(-100*time.Millisecond), time.Now())

	collector.Settle(2 * time.Second)
	assert.Equal(t, 1, collector.Blocks(), "the final block was lost")
	assert.Zero(t, collector.Dropped())
}

func formatFloat(v float64) string {
	return strconv.FormatFloat(v, 'f', -1, 64)
}

// TestPeakRateFindsABurstTheTotalHides is why a counter reports a rate as well
// as a total. A link saturates for a moment inside a much longer block, and a
// total spread over the whole block averages that moment away.
func TestPeakRateFindsABurstTheTotalHides(t *testing.T) {
	// Two seconds of near silence with one 100ms burst of 500MB.
	var series []point
	value := 0.0
	for offset := 0; offset <= 2000; offset += 100 {
		series = append(series, point{at: at(offset), value: value})
		if offset == 1000 {
			value += 500e6
		} else {
			value += 1e6
		}
	}

	stat, _, _, ok := reduce(series, KindCounter, at(0), at(2000), 100*time.Millisecond)
	require.True(t, ok)

	meanRate := stat.Total / 2
	assert.InDelta(t, 5e9, stat.PeakRate, 1e6, "the burst rate is 500MB over 100ms")
	assert.Greater(t, stat.PeakRate/meanRate, 15.0,
		"the mean rate understated the burst by more than fifteen times")
}

// TestPeakRateFollowsTheSourceNotTheScraper covers a source refreshing at
// 1 Hz under a 10 Hz poll. Nine flat readings and one jump must read as one
// second of advance, not a tenth of one. The bracket starts between two
// refreshes, as a block does, so the first change has no refresh to measure
// from.
func TestPeakRateFollowsTheSourceNotTheScraper(t *testing.T) {
	slow := func(from, to int) []point {
		var series []point
		for offset := from; offset <= to; offset += 100 {
			series = append(series, point{at: at(offset), value: float64(offset/1000) * 1000})
		}
		return series
	}

	assert.InDelta(t, 1000, peakRate(slow(900, 3000)), 0.001, "three refreshes")
	assert.InDelta(t, 1000.0/1.5, peakRate(slow(0, 1500)), 0.001, "one refresh falls back to the bracket mean")
	assert.Zero(t, peakRate(slow(1000, 1900)), "no refresh is no advance")
}

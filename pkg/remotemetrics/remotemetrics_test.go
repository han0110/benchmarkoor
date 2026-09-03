package remotemetrics

import (
	"context"
	"encoding/json"
	"math"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strconv"
	"sync/atomic"
	"testing"
	"time"

	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"
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

// TestScrapeLearnsKindsFromTheExposition is what makes the package generic.
// Nothing here names DCGM, so any Prometheus endpoint works unchanged.
func TestScrapeLearnsKindsFromTheExposition(t *testing.T) {
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		w.Header().Set("Content-Type", "text/plain; version=0.0.4")
		_, _ = w.Write([]byte(exposition))
	}))
	defer server.Close()

	scraper := NewScraper([]Endpoint{{
		Name:   "node0",
		URL:    server.URL,
		Labels: map[string]string{"node": "node0"},
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
			"# TYPE c counter\nc{gpu=\"0\"} " + formatFloat(cycles) + "\n" +
				"# TYPE g gauge\ng{gpu=\"0\"} 0.5\n"))
	}))
	defer server.Close()

	scraper := NewScraper([]Endpoint{{Name: "node0", URL: server.URL}}, 20*time.Millisecond, time.Second)
	ctx, cancel := context.WithCancel(context.Background())
	go scraper.Run(ctx)

	time.Sleep(300 * time.Millisecond)
	start := time.Now().Add(-200 * time.Millisecond)
	end := time.Now().Add(-50 * time.Millisecond)
	cancel()

	windows := scraper.Reduce(start, end)
	require.Len(t, windows, 1)

	window := windows[0]
	assert.Positive(t, window.Metrics["c"].Total, "the counter advanced during the window")
	assert.InDelta(t, 0.5, window.Metrics["g"].Mean, 0.001)
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
		_, _ = w.Write([]byte("# TYPE c counter\nc{gpu=\"0\"} " + formatFloat(cycles) + "\n"))
	}))
	defer server.Close()

	scraper := NewScraper([]Endpoint{{Name: "node0", URL: server.URL}}, 50*time.Millisecond, time.Second)
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
	path := filepath.Join(t.TempDir(), ArtifactName)
	require.NoError(t, collector.Write(path))
	_, err := os.Stat(path)
	assert.True(t, os.IsNotExist(err), "an empty run must write no artifact")
}

// TestArtifactListsEachDeviceOnce covers the shape a run stores. Repeating the
// label set on every block of every device would dominate the file.
func TestArtifactListsEachDeviceOnce(t *testing.T) {
	scraper := NewScraper([]Endpoint{{Name: "node0"}}, time.Second, time.Second)
	now := time.Now()
	for i := range 4 {
		at := now.Add(time.Duration(i) * 100 * time.Millisecond)
		scraper.points[series{metric: "c", device: "node0,gpu=0"}] = append(
			scraper.points[series{metric: "c", device: "node0,gpu=0"}],
			point{at: at, value: float64(i * 100)})
	}
	scraper.kinds["c"] = KindCounter
	scraper.devices["node0,gpu=0"] = map[string]string{"node": "node0", "gpu": "0"}

	collector := NewCollector(scraper)
	collector.RecordBlock("a.json", "0x1", now, now.Add(200*time.Millisecond))
	collector.RecordBlock("a.json", "0x2", now.Add(100*time.Millisecond), now.Add(300*time.Millisecond))
	require.Equal(t, 2, collector.Blocks())

	path := filepath.Join(t.TempDir(), ArtifactName)
	require.NoError(t, collector.Write(path))

	data, err := os.ReadFile(path)
	require.NoError(t, err)

	var artifact Artifact
	require.NoError(t, json.Unmarshal(data, &artifact))
	assert.Equal(t, schemaVersion, artifact.SchemaVersion)
	require.Len(t, artifact.Devices, 1, "one device listed once")
	assert.Equal(t, "node0", artifact.Devices[0].Labels["node"])
	require.Len(t, artifact.Tests["a.json"], 2, "both blocks kept")
	assert.Equal(t, []string{"device", "scrapes", "updates", "c.total"}, artifact.Columns)
	assert.Equal(t, []string{"c"}, collector.MetricNames())

	row := artifact.Tests["a.json"]["0x1"][0]
	require.Len(t, row, len(artifact.Columns), "a row carries one value per column")
	assert.Equal(t, int64(0), row[0], "rows reference the device table")
	assert.Equal(t, int64(200), row[3], "the counter total lands in its column")
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
			"# TYPE c counter\nc{gpu=\"0\"} NaN\n" +
				"# TYPE g gauge\ng{gpu=\"0\"} +Inf\n" +
				"# TYPE h gauge\nh{gpu=\"0\"} 0.5\n"))
	}))
	defer server.Close()

	scraper := NewScraper([]Endpoint{{Name: "node0", URL: server.URL}}, time.Second, time.Second)
	require.NoError(t, scraper.scrape(context.Background(), scraper.endpoints[0]))

	assert.Empty(t, scraper.points[series{metric: "c", device: "node0,gpu=0"}], "NaN was stored")
	assert.Empty(t, scraper.points[series{metric: "g", device: "node0,gpu=0"}], "Inf was stored")
	assert.Len(t, scraper.points[series{metric: "h", device: "node0,gpu=0"}], 1,
		"a healthy sample beside a bad one must survive")
}

// TestUnmeasuredMetricIsNotAZero is the difference between a GPU that did no
// work and a GPU nothing observed. Both would otherwise be a row of zeroes.
func TestUnmeasuredMetricIsNotAZero(t *testing.T) {
	scraper := NewScraper([]Endpoint{{Name: "node0"}}, time.Second, time.Second)
	now := time.Now()
	key := series{metric: "present", device: "node0,gpu=0"}
	for i := range 4 {
		scraper.points[key] = append(scraper.points[key],
			point{at: now.Add(time.Duration(i) * 100 * time.Millisecond), value: float64(i * 100)})
	}
	scraper.kinds["present"] = KindCounter
	scraper.kinds["absent"] = KindCounter
	scraper.devices["node0,gpu=0"] = map[string]string{"node": "node0"}

	collector := NewCollector(scraper)
	collector.RecordBlock("a.json", "0x1", now, now.Add(200*time.Millisecond))
	require.Equal(t, 1, collector.Blocks())

	// A column that appears only later leaves the earlier row short, and the
	// padding must not read as a measurement.
	collector.columnIndex("absent", "total")

	path := filepath.Join(t.TempDir(), ArtifactName)
	require.NoError(t, collector.Write(path))

	data, err := os.ReadFile(path)
	require.NoError(t, err)

	var artifact Artifact
	require.NoError(t, json.Unmarshal(data, &artifact))

	row := artifact.Tests["a.json"]["0x1"][0]
	require.Len(t, row, len(artifact.Columns))
	assert.Equal(t, int64(200), row[3], "the measured counter keeps its value")
	assert.Equal(t, int64(noReading), row[4], "an unmeasured column must not be zero")
}

// TestQuantiseRefusesWhatInt64CannotHold keeps a sentinel or an overflowing
// scale from landing in the artifact as a real number.
func TestQuantiseRefusesWhatInt64CannotHold(t *testing.T) {
	assert.Equal(t, int64(5000), quantise(0.5, gaugeScale))
	assert.Equal(t, int64(noReading), quantise(math.NaN(), 1))
	assert.Equal(t, int64(noReading), quantise(math.Inf(1), 1))
	assert.Equal(t, int64(noReading), quantise(9.0e18, gaugeScale))
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
		_, _ = w.Write([]byte("# TYPE c counter\nc{gpu=\"0\"} 1\n"))
	}))
	defer healthy.Close()

	scraper := NewScraper([]Endpoint{
		{Name: "stalled", URL: stalled.URL},
		{Name: "healthy", URL: healthy.URL},
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

// TestSettleKeepsTheFinalBlock covers the last block of a run. Nothing arrives
// after it to carry its window, so without a wait it would be dropped.
func TestSettleKeepsTheFinalBlock(t *testing.T) {
	var cycles float64
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		cycles += 100
		w.Header().Set("Content-Type", "text/plain; version=0.0.4")
		_, _ = w.Write([]byte("# TYPE c counter\nc{gpu=\"0\"} " + formatFloat(cycles) + "\n"))
	}))
	defer server.Close()

	scraper := NewScraper([]Endpoint{{Name: "node0", URL: server.URL}}, 50*time.Millisecond, time.Second)
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

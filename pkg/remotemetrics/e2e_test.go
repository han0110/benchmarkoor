//go:build e2e

// This file proves the whole path end to end against a real proving cluster.
// It needs a provoor deployment with its telemetry sidecar, and a provoor
// forwarder in front of it.
//
//	provoor up --config examples/local-openvm-1gpu.yaml
//	provoor serve --coordinator-endpoint http://127.0.0.1:3000 ... --listen 127.0.0.1:8551
//	PROVOOR_INPUT=<path to warmup_input.bin> \
//	  go test ./pkg/remotemetrics/ -tags e2e -v -timeout 20m
package remotemetrics

import (
	"bytes"
	"context"
	"encoding/hex"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"os"
	"path/filepath"
	"testing"
	"time"

	"github.com/stretchr/testify/require"
)

const (
	sidecarURL = "http://127.0.0.1:9401/metrics"
	forwardURL = "http://127.0.0.1:8551"
)

// prove posts one proof and reports the instants it occupied, which is what a
// run measures for a block.
func prove(t *testing.T, input, expected string) (start, end time.Time, status string, committed string) {
	t.Helper()
	payload := map[string]string{
		"blockHash":               "0xe2e",
		"blockNumber":             "0x1",
		"gasUsed":                 "0x0",
		"statelessInput":          input,
		"expectedStatelessOutput": expected,
	}
	body, err := json.Marshal(map[string]any{
		"jsonrpc": "2.0", "id": 1,
		"method": "engine_proveStatelessValidator",
		"params": []any{payload},
	})
	require.NoError(t, err)

	start = time.Now()
	resp, err := http.Post(forwardURL, "application/json", bytes.NewReader(body))
	require.NoError(t, err)
	defer func() { _ = resp.Body.Close() }()
	raw, err := io.ReadAll(resp.Body)
	require.NoError(t, err)
	end = time.Now()

	var answer struct {
		Result struct {
			Status          string `json:"status"`
			StatelessOutput string `json:"statelessOutput"`
		} `json:"result"`
		Error *struct {
			Message string `json:"message"`
		} `json:"error"`
	}
	require.NoError(t, json.Unmarshal(raw, &answer), "response %s", raw)
	require.Nil(t, answer.Error, "forwarder returned an error")
	return start, end, answer.Result.Status, answer.Result.StatelessOutput
}

// TestProofWindowCarriesRealGPUWork is the end-to-end gate. It scrapes the
// sidecar while a real proof runs and checks that the window reduced over that
// proof reports work the GPU actually did.
func TestProofWindowCarriesRealGPUWork(t *testing.T) {
	inputPath := os.Getenv("PROVOOR_INPUT")
	require.NotEmpty(t, inputPath, "set PROVOOR_INPUT to the stateless input file")
	raw, err := os.ReadFile(inputPath)
	require.NoError(t, err)
	input := "0x" + hex.EncodeToString(raw)

	scraper := NewScraper([]Endpoint{{
		Exporter: ExporterDCGM,
		URL:      sidecarURL,
		Labels:   map[string]string{"node": "local"},
	}}, 100*time.Millisecond, 2*time.Second)

	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	go scraper.Run(ctx)

	// Let the buffer fill so the window has a reading on either side.
	time.Sleep(2 * time.Second)

	// The first proof answers INVALID and echoes the real commitment, which
	// the second proof then matches. Both do the same GPU work.
	_, _, status, committed := prove(t, input, "0x"+hex.EncodeToString(make([]byte, 32)))
	t.Logf("first proof answered %s, committed %s", status, committed)
	require.NotEmpty(t, committed, "the forwarder did not echo a commitment")

	start, end, status, _ := prove(t, input, committed)
	require.Equal(t, "VALID", status, "the second proof did not verify")
	t.Logf("proof took %s", end.Sub(start).Round(time.Millisecond))

	// Record at production timing, the instant the call returned and with no
	// pause for the scraper. The window resolves once the samples catch up,
	// as they do while a run continues.
	collector := NewCollector(scraper)
	collector.RecordBlock("e2e.json", "0xe2e", start, end)

	time.Sleep(500 * time.Millisecond)
	require.Equal(t, 1, collector.Blocks(), "the proof window recorded no block")
	require.Zero(t, collector.Dropped(), "a window carried no usable samples")

	windows := scraper.Reduce(start, end)
	require.NotEmpty(t, windows)
	window := windows[0]

	elapsed := window.Metrics["DCGM_FI_PROF_SM_CYCLES_ELAPSED_TOTAL"].Total
	active := window.Metrics["DCGM_FI_PROF_SM_CYCLES_ACTIVE_TOTAL"].Total
	integer := window.Metrics["DCGM_FI_PROF_INT_CYCLES_ACTIVE_TOTAL"].Total
	power := window.Metrics["DCGM_FI_DEV_POWER_USAGE"].Mean

	t.Logf("device %s", window.Device)
	t.Logf("  scrapes=%d updates=%d over %s",
		window.Scrapes, window.Updates, end.Sub(start).Round(time.Millisecond))
	t.Logf("  smActive=%.4f intActive=%.4f",
		active/elapsed, integer/elapsed)
	t.Logf("  meanPower=%.1fW", power)
	t.Logf("  dramActive mean=%.4f max=%.4f",
		window.Metrics["DCGM_FI_PROF_DRAM_ACTIVE"].Mean,
		window.Metrics["DCGM_FI_PROF_DRAM_ACTIVE"].Max)
	t.Logf("  fbUsed max=%.0fMiB of %.0fMiB",
		window.Metrics["DCGM_FI_DEV_FB_USED"].Max,
		window.Metrics["DCGM_FI_DEV_FB_TOTAL"].Max)
	t.Logf("  tempMargin min=%.0fC",
		window.Metrics["DCGM_FI_DEV_GPU_TEMP_MARGIN_CELSIUS"].Min)

	require.Positive(t, elapsed, "no SM cycles elapsed during the proof")
	require.Positive(t, active, "the GPU did no work during the proof")
	require.Positive(t, power, "the GPU drew no power during the proof")
	require.Positive(t, window.Updates, "the source never refreshed during the proof")

	// A STARK prover over a Goldilocks field runs on the integer pipe, so a
	// proof that reports no integer activity is measuring the wrong thing.
	require.Positive(t, integer, "the integer pipe was idle during a STARK proof")

	// The sample rate the source actually delivered, which DCGM can silently
	// drop to 1 Hz. The window is only as trustworthy as this number.
	rate := float64(window.Updates) / end.Sub(start).Seconds()
	t.Logf("  source refresh rate %.2f Hz", rate)

	require.Positive(t, window.Metrics["DCGM_FI_DEV_FB_USED"].Max,
		"the proof used no frame buffer, so the reading is not the prover")

	// The artifact is what a run actually stores, so read it back rather than
	// trusting the in-memory collector.
	dir := t.TempDir()
	_, err = collector.Write(dir)
	require.NoError(t, err)

	data, err := os.ReadFile(filepath.Join(dir, ArtifactNames[ExporterDCGM]))
	require.NoError(t, err)

	var artifact Artifact
	require.NoError(t, json.Unmarshal(data, &artifact))
	require.Len(t, artifact.Devices, 1)
	require.Len(t, artifact.Tests["e2e.json"], 1)

	column := -1
	for i, name := range artifact.Columns {
		if name == "DCGM_FI_PROF_SM_CYCLES_ACTIVE_TOTAL.total" {
			column = i
		}
	}
	require.Positive(t, column, "the artifact lost the active cycles column")

	row := artifact.Tests["e2e.json"]["0xe2e"][0]
	require.Len(t, row, len(artifact.Columns))
	require.NotNil(t, row[column], "the stored artifact lost the work the window measured")
	require.Positive(t, *row[column], "the stored artifact lost the work the window measured")

	// Size drives the publish constraint. The column and device tables are
	// written once, so the row is the only part that scales with a run.
	encoded, err := json.Marshal(row)
	require.NoError(t, err)
	// A rig of four nodes with four GPUs each, over a long run.
	const rigDevices, rigBlocks = 16, 7349
	projected := len(encoded) * rigDevices * rigBlocks
	t.Logf("artifact %d bytes total, %d bytes per row over %d columns",
		len(data), len(encoded), len(artifact.Columns))
	t.Logf("projects to %.1f MB for %d devices over %d blocks",
		float64(projected)/(1<<20), rigDevices, rigBlocks)

	// No hostname may reach a published result.
	require.NotContains(t, string(data), "hostname")

	fmt.Fprintf(os.Stderr, "e2e window: smActive=%.4f intActive=%.4f power=%.1fW rate=%.2fHz artifact=%dB\n",
		active/elapsed, integer/elapsed, power, rate, len(data))
}

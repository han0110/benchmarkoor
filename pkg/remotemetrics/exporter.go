package remotemetrics

import (
	dto "github.com/prometheus/client_model/go"
)

// Exporter names a kind of endpoint. It selects the series recorded from the
// endpoint and the artifact its devices land in, so a configuration names the
// exporter rather than restating its metrics.
const (
	// ExporterDCGM is the NVIDIA GPU exporter provoor runs beside every
	// worker, one device per GPU.
	ExporterDCGM = "dcgm-exporter"
	// ExporterNode is the Prometheus node exporter provoor runs on every
	// host, one device per machine.
	ExporterNode = "node-exporter"
)

// ArtifactNames maps an exporter to the file its rows are written to.
var ArtifactNames = map[string]string{
	ExporterDCGM: "result.device-metrics.json",
	ExporterNode: "result.node-metrics.json",
}

// artifactColumns lists, for every metric an artifact carries, the statistics
// written for it. The lists are exactly what the results page reads, and a
// test on each side fails when they drift. A metric outside its list is never
// buffered, and a statistic outside it is never written.
var artifactColumns = map[string]map[string][]string{
	ExporterDCGM: {
		"DCGM_FI_PROF_SM_CYCLES_ELAPSED_TOTAL": {"total"},
		"DCGM_FI_PROF_SM_CYCLES_ACTIVE_TOTAL":  {"total"},
		"DCGM_FI_PROF_INT_CYCLES_ACTIVE_TOTAL": {"total"},
		"DCGM_FI_PROF_PCIE_TX_BYTES_TOTAL":     {"rate_max"},
		"DCGM_FI_PROF_PCIE_RX_BYTES_TOTAL":     {"rate_max"},
		"DCGM_FI_DEV_POWER_USAGE":              {"mean", "max"},
		"DCGM_FI_DEV_ENFORCED_POWER_LIMIT":     {"max"},
		"DCGM_FI_DEV_POWER_VIOLATION":          {"total"},
		"DCGM_FI_DEV_THERMAL_VIOLATION":        {"total"},
		"DCGM_FI_DEV_PCIE_REPLAY_COUNTER":      {"total"},
		"DCGM_FI_PROF_DRAM_ACTIVE":             {"mean"},
		"DCGM_FI_PROF_SM_OCCUPANCY":            {"mean"},
		"DCGM_FI_DEV_GPU_TEMP_MARGIN_CELSIUS":  {"min"},
		"DCGM_FI_DEV_FB_USED":                  {"max"},
		"DCGM_FI_DEV_FB_TOTAL":                 {"max"},
	},
	ExporterNode: {
		"node_cpu_seconds_total":         {"total"},
		"node_cpu_busy_seconds_total":    {"total"},
		"node_memory_MemTotal_bytes":     {"max"},
		"node_memory_MemAvailable_bytes": {"mean", "min"},
	},
}

// preset describes what one kind of exporter contributes.
type preset struct {
	// series maps an exposition family to the series recorded from it, each
	// under its own name. A family split by a label records one series per
	// selection.
	series map[string][]selection
	// sumOver lists the labels added across, so a per core series becomes
	// one series for the machine. A summed label names a dimension rather
	// than a device and stays out of the device identity.
	sumOver map[string]struct{}
}

// selection records one series from a family, keeping only the samples whose
// labels match. An empty keep takes every sample.
type selection struct {
	name string
	keep map[string]map[string]struct{}
}

// matches reports whether a sample's labels fall inside the selection. A
// sample missing a filtered label falls outside it.
func (sel selection) matches(metric *dto.Metric) bool {
	values := map[string]string{}
	for _, label := range metric.GetLabel() {
		values[label.GetName()] = label.GetValue()
	}
	for name, allowed := range sel.keep {
		if _, ok := allowed[values[name]]; !ok {
			return false
		}
	}
	return true
}

// dcgmExporterPreset records every listed field under its own name. The
// sidecar already narrows the field list, so nothing is summed or filtered.
var dcgmExporterPreset = func() preset {
	series := map[string][]selection{}
	for metric := range artifactColumns[ExporterDCGM] {
		series[metric] = []selection{{name: metric}}
	}
	return preset{series: series}
}()

// nodeExporterPreset reduces a machine to the quantities the panel plots.
//
// The processor family is recorded twice, once over every mode and once over
// the busy modes, so a window reports busy time as a share of all time with
// no need to know the core count. Idle and iowait are the modes left out of
// busy. Both sum across cores, and memory needs no summing, having no labels.
var nodeExporterPreset = preset{
	series: map[string][]selection{
		"node_cpu_seconds_total": {
			{name: "node_cpu_seconds_total"},
			{name: "node_cpu_busy_seconds_total", keep: map[string]map[string]struct{}{
				"mode": set("user", "nice", "system", "irq", "softirq", "steal"),
			}},
		},
		"node_memory_MemTotal_bytes":     {{name: "node_memory_MemTotal_bytes"}},
		"node_memory_MemAvailable_bytes": {{name: "node_memory_MemAvailable_bytes"}},
	},
	sumOver: set("cpu", "mode"),
}

// presets holds one entry per exporter this package understands.
var presets = map[string]preset{
	ExporterDCGM: dcgmExporterPreset,
	ExporterNode: nodeExporterPreset,
}

// identifies reports whether a label takes part in the device identity.
func (p preset) identifies(label string) bool {
	_, summed := p.sumOver[label]
	return !summed
}

// set builds a lookup from a list of names.
func set(names ...string) map[string]struct{} {
	out := make(map[string]struct{}, len(names))
	for _, name := range names {
		out[name] = struct{}{}
	}
	return out
}

import { useMemo } from 'react'
import { reduceGpuMetrics, type GpuDataPoint } from '@/utils/gpuMetrics'
import { NO_METRICS } from '@/utils/remoteMetrics'
import { useNameDisplayMode } from '@/hooks/useNameDisplayMode'
import { ChartSection, StatCard } from './RemoteMetricsPanel'
import {
  BUSIEST_COLOR,
  PERCENT_FLOOR,
  figure,
  useChartOptionBuilder,
  useDarkMode,
  useStatusFilter,
  type RemoteMetricsSection,
  type RemoteMetricsSectionProps,
  type Series,
} from './remoteMetricsChart'

const describeGpus = (point: GpuDataPoint) => `GPUs: ${point.busyDevices} busy of ${point.devices} reporting`

/** The GPU half of the remote metrics section, absent from a run that charts no GPU. */
export function useGpuMetricsSection({
  metrics,
  suiteTests,
  searchQuery,
  tests,
  statusFilter = 'all',
  onTestClick,
  zoomRange,
  onZoom,
}: RemoteMetricsSectionProps): RemoteMetricsSection | null {
  const isDark = useDarkMode()
  const { mode: nameMode } = useNameDisplayMode()
  const includeTest = useStatusFilter(tests, statusFilter)

  const { dataPoints, summary, hasPower, hasPcieRate, hasDuration } = useMemo(
    () => reduceGpuMetrics(metrics ?? NO_METRICS, { suiteTests, searchQuery, includeTest }),
    [metrics, suiteTests, searchQuery, includeTest],
  )

  const { makeOption, highlightedTestRef } = useChartOptionBuilder<GpuDataPoint>({ dataPoints, isDark, nameMode, zoomRange, describe: describeGpus })

  const chartOptions = useMemo(() => {
    const percent = (v: number) => `${v.toFixed(1)}%`
    const ratio = (mean: Series<GpuDataPoint>, busiest: (point: GpuDataPoint) => number | null) =>
      makeOption([mean, { name: 'Busiest GPU', color: BUSIEST_COLOR, value: busiest }], percent, undefined, PERCENT_FLOOR)

    return {
      powerOption: makeOption(
        [
          { name: 'Mean per GPU', color: '#f59e0b', value: (p) => p.meanWatts },
          { name: 'Peak of any GPU', color: '#dc2626', value: (p) => p.peakWatts },
        ],
        (v) => `${v.toFixed(0)} W`,
        summary.powerLimit === null ? undefined : { value: summary.powerLimit, label: 'cap' },
      ),
      smActiveOption: ratio({ name: 'Mean per GPU', color: '#22c55e', value: (p) => p.smActive }, (p) => p.busiestSmActive),
      intOption: ratio({ name: 'Mean per GPU', color: '#8b5cf6', value: (p) => p.intActive }, (p) => p.busiestIntActive),
      occupancyOption: ratio({ name: 'Mean per GPU', color: '#0ea5e9', value: (p) => p.smOccupancy }, (p) => p.busiestSmOccupancy),
      dramOption: ratio({ name: 'Mean per GPU', color: '#06b6d4', value: (p) => p.dramActive }, (p) => p.busiestDramActive),
      pcieOption: makeOption(
        [
          { name: 'RX', color: '#14b8a6', value: (p) => p.pcieRxRate },
          { name: 'TX', color: '#a855f7', value: (p) => p.pcieTxRate },
        ],
        (v) => `${v.toFixed(2)} GB/s`,
      ),
      throttleOption: makeOption(
        [
          { name: 'Power cap', color: '#f59e0b', value: (p) => p.throttledPowerShare },
          { name: 'Thermal', color: '#dc2626', value: (p) => p.throttledThermalShare },
        ],
        percent,
        undefined,
        PERCENT_FLOOR,
      ),
      tempOption: makeOption([{ name: 'Temp Margin', color: '#ef4444', value: (p) => p.tempMargin }], (v) => `${v.toFixed(0)} °C`),
    }
  }, [makeOption, summary])

  if (dataPoints.length === 0) {
    return null
  }

  const chart = (title: string, option: object) => (
    <ChartSection title={title} option={option} onZoom={onZoom} onPointClick={onTestClick} highlightedTestRef={highlightedTestRef} />
  )

  return {
    source: {
      name: 'dcgm-exporter',
      title: "Counters and gauges scraped from the DCGM exporter on every node, reduced over each block's proving window",
    },
    cards: (
      <>
        <StatCard label="Mean SM Active" value={`${figure(summary.meanSmActive, 1)}%`} />
        <StatCard label="Peak SM Active" value={`${figure(summary.peakSmActive, 1)}%`} />
        {hasPower && <StatCard label="Mean GPU Power" value={`${figure(summary.meanWatts, 0)} W`} />}
        {hasPower && <StatCard label="Peak GPU Power" value={`${figure(summary.peakWatts, 0)} / ${figure(summary.powerLimit, 0)} W`} />}
        <StatCard label="Peak Frame Buffer" value={`${figure(summary.peakFbUsed, 1)} / ${figure(summary.fbTotal, 1)} GiB`} />
        {hasPcieRate && <StatCard label="Peak PCIe Rate" value={`${figure(summary.peakLink, 2)} GB/s`} />}
        {hasDuration && <StatCard label="Mean Throttled Time" value={`${figure(summary.throttledShare, 1)}%`} />}
        <StatCard label="Min Temp Margin" value={`${figure(summary.minTempMargin, 0)} °C`} />
        <StatCard label="PCIe Replays" value={figure(summary.pcieReplays, 0)} />
      </>
    ),
    charts: (
      <>
        {hasPower && chart('GPU Power (W)', chartOptions.powerOption)}
        {chart('SM Active %', chartOptions.smActiveOption)}
        {chart('Integer Pipe Active %', chartOptions.intOption)}
        {chart('SM Occupancy %', chartOptions.occupancyOption)}
        {chart('DRAM Active %', chartOptions.dramOption)}
        {hasPcieRate && chart('Peak PCIe Rate (GB/s)', chartOptions.pcieOption)}
        {hasDuration && chart('Throttled Time %, Worst GPU', chartOptions.throttleOption)}
        {chart('Min Temp Margin (°C)', chartOptions.tempOption)}
      </>
    ),
  }
}

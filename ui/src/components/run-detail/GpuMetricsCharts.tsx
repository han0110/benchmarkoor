import { useCallback, useMemo, useState } from 'react'
import type { DeviceMetrics, SuiteTest, TestEntry } from '@/api/types'
import { reduceGpuMetrics, type GpuDataPoint } from '@/utils/gpuMetrics'
import { useNameDisplayMode } from '@/hooks/useNameDisplayMode'
import type { TestStatusFilter } from './TestsTable'
import { ChartSection, RemoteMetricsPanel, StatCard } from './RemoteMetricsPanel'
import { BUSIEST_COLOR, PERCENT_FLOOR, figure, useChartOptionBuilder, useDarkMode, useStatusFilter, type Series } from './remoteMetricsChart'

const describeGpus = (point: GpuDataPoint) => `GPUs: ${point.busyDevices} busy of ${point.devices} reporting`

interface GpuMetricsChartsProps {
  metrics: DeviceMetrics
  /** Suite tests in canonical run order, so Test # matches the other charts. */
  suiteTests?: SuiteTest[]
  /** Only tests whose name matches this query are charted. */
  searchQuery?: string
  /** Test results, which carry the pass or fail state the status filter reads. */
  tests?: Record<string, TestEntry>
  statusFilter?: TestStatusFilter
  onTestClick?: (testName: string) => void
}

export function GpuMetricsCharts({ metrics, suiteTests, searchQuery, tests, statusFilter = 'all', onTestClick }: GpuMetricsChartsProps) {
  const isDark = useDarkMode()
  const { mode: nameMode } = useNameDisplayMode()
  const [zoomRange, setZoomRange] = useState({ start: 0, end: 100 })

  const handleZoom = useCallback((start: number, end: number) => {
    setZoomRange({ start, end })
  }, [])

  const includeTest = useStatusFilter(tests, statusFilter)

  const { dataPoints, summary, hasPower, hasPcieRate, hasDuration } = useMemo(
    () => reduceGpuMetrics(metrics, { suiteTests, searchQuery, includeTest }),
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
    <ChartSection title={title} option={option} onZoom={handleZoom} onPointClick={onTestClick} highlightedTestRef={highlightedTestRef} />
  )

  return (
    <RemoteMetricsPanel
      title="Remote GPU Metrics"
      source="dcgm-exporter"
      sourceTitle="Counters and gauges scraped from the DCGM exporter on every node, reduced over each block's proving window"
      cards={
        <>
          <StatCard label="GPUs" value={`${summary.devices}`} />
          <StatCard label="Blocks" value={`${summary.blocks}`} />
          {hasPower && <StatCard label="Mean GPU Power" value={`${figure(summary.meanWatts, 0)} W`} />}
          {hasPower && <StatCard label="Peak GPU Power" value={`${figure(summary.peakWatts, 0)} / ${figure(summary.powerLimit, 0)} W`} />}
          <StatCard label="Mean SM Active" value={`${figure(summary.meanSmActive, 1)}%`} />
          <StatCard label="Peak SM Active" value={`${figure(summary.peakSmActive, 1)}%`} />
          <StatCard label="Peak Frame Buffer" value={`${figure(summary.peakFbUsed, 1)} / ${figure(summary.fbTotal, 1)} GiB`} />
          {hasPcieRate && <StatCard label="Peak PCIe Rate" value={`${figure(summary.peakLink, 2)} GB/s`} />}
          <StatCard label="Min Temp Margin" value={`${figure(summary.minTempMargin, 0)} °C`} />
          {hasDuration && <StatCard label="Throttled Time, All GPUs" value={`${figure(summary.throttledShare, 1)}%`} />}
          <StatCard label="PCIe Replays" value={figure(summary.pcieReplays, 0)} />
          <StatCard label="DCGM Refresh" value={`${figure(summary.meanRefreshRatio, 0)}%`} />
        </>
      }
      charts={
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
      }
      footer="GPU usage per block (ordered by execution) - mean series include idle GPUs - drag slider to zoom"
    />
  )
}

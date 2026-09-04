import { useMemo } from 'react'
import { cpuUsageFigure, reduceNodeMetrics, type NodeDataPoint } from '@/utils/nodeMetrics'
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
} from './remoteMetricsChart'

const describeNodes = (point: NodeDataPoint) => `Nodes: ${point.devices} reporting`

/** The node half of the remote metrics section, absent from a run that charts no node. */
export function useNodeMetricsSection({
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

  const { dataPoints, summary } = useMemo(
    () => reduceNodeMetrics(metrics ?? NO_METRICS, { suiteTests, searchQuery, includeTest }),
    [metrics, suiteTests, searchQuery, includeTest],
  )

  const { makeOption, highlightedTestRef } = useChartOptionBuilder<NodeDataPoint>({ dataPoints, isDark, nameMode, zoomRange, describe: describeNodes })

  const chartOptions = useMemo(
    () => ({
      // One fully busy processor reads 100 percent, so the axis tops out at
      // the processors of the node and the room under it is idle time.
      cpuOption: makeOption(
        [
          { name: 'Mean per node', color: '#0ea5e9', value: (p) => p.cpuBusy },
          { name: 'Busiest node', color: BUSIEST_COLOR, value: (p) => p.busiestCpuBusy },
        ],
        (v) => `${v.toFixed(0)}%`,
        summary.cpuCores === null ? undefined : { value: summary.cpuCores * 100, label: `(${summary.cpuCores} processors)`, wholeScale: true },
        PERCENT_FLOOR,
      ),
      // Capacity stays on the tile. An axis pinned to it hides the variation
      // of a rig that uses a quarter of its memory.
      ramOption: makeOption(
        [
          { name: 'Mean per node', color: '#f59e0b', value: (p) => p.ramUsedGiB },
          { name: 'Peak of any node', color: '#dc2626', value: (p) => p.peakRamUsedGiB },
        ],
        (v) => `${v.toFixed(1)} GiB`,
      ),
    }),
    [makeOption, summary],
  )

  if (dataPoints.length === 0) {
    return null
  }

  const chart = (title: string, option: object) => (
    <ChartSection title={title} option={option} onZoom={onZoom} onPointClick={onTestClick} highlightedTestRef={highlightedTestRef} />
  )

  return {
    source: {
      name: 'node-exporter',
      title: "Processor and memory counters scraped from the node exporter on every node, reduced over each block's proving window",
    },
    cards: (
      <>
        <StatCard label="Mean CPU Usage" value={cpuUsageFigure(summary.meanCpuBusy, summary.meanCpuCores)} />
        <StatCard label="Peak CPU Usage" value={cpuUsageFigure(summary.peakCpuBusy, summary.peakCpuCores)} />
        <StatCard label="Peak RAM Used" value={`${figure(summary.peakRamUsed, 1)} / ${figure(summary.ramTotal, 1)} GiB`} />
      </>
    ),
    charts: (
      <>
        {chart('CPU Usage %', chartOptions.cpuOption)}
        {chart('RAM Used (GiB)', chartOptions.ramOption)}
      </>
    ),
  }
}

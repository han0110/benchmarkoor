import { useCallback, useMemo, useState } from 'react'
import type { DeviceMetrics, SuiteTest, TestEntry } from '@/api/types'
import { reduceNodeMetrics, type NodeDataPoint } from '@/utils/nodeMetrics'
import { useNameDisplayMode } from '@/hooks/useNameDisplayMode'
import type { TestStatusFilter } from './TestsTable'
import { ChartSection, RemoteMetricsPanel, StatCard } from './RemoteMetricsPanel'
import { BUSIEST_COLOR, PERCENT_FLOOR, figure, useChartOptionBuilder, useDarkMode, useStatusFilter } from './remoteMetricsChart'

const describeNodes = (point: NodeDataPoint) => `Nodes: ${point.devices} reporting`

interface NodeMetricsChartsProps {
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

export function NodeMetricsCharts({ metrics, suiteTests, searchQuery, tests, statusFilter = 'all', onTestClick }: NodeMetricsChartsProps) {
  const isDark = useDarkMode()
  const { mode: nameMode } = useNameDisplayMode()
  const [zoomRange, setZoomRange] = useState({ start: 0, end: 100 })

  const handleZoom = useCallback((start: number, end: number) => {
    setZoomRange({ start, end })
  }, [])

  const includeTest = useStatusFilter(tests, statusFilter)

  const { dataPoints, summary } = useMemo(
    () => reduceNodeMetrics(metrics, { suiteTests, searchQuery, includeTest }),
    [metrics, suiteTests, searchQuery, includeTest],
  )

  const { makeOption, highlightedTestRef } = useChartOptionBuilder<NodeDataPoint>({ dataPoints, isDark, nameMode, zoomRange, describe: describeNodes })

  const chartOptions = useMemo(
    () => ({
      cpuOption: makeOption(
        [
          { name: 'Mean per node', color: '#0ea5e9', value: (p) => p.cpuBusy },
          { name: 'Busiest node', color: BUSIEST_COLOR, value: (p) => p.busiestCpuBusy },
        ],
        (v) => `${v.toFixed(1)}%`,
        undefined,
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
    [makeOption],
  )

  if (dataPoints.length === 0) {
    return null
  }

  const chart = (title: string, option: object) => (
    <ChartSection title={title} option={option} onZoom={handleZoom} onPointClick={onTestClick} highlightedTestRef={highlightedTestRef} />
  )

  return (
    <RemoteMetricsPanel
      title="Remote CPU/RAM Metrics"
      source="node-exporter"
      sourceTitle="Processor and memory counters scraped from the node exporter on every node, reduced over each block's proving window"
      cards={
        <>
          <StatCard label="Nodes" value={`${summary.devices}`} />
          <StatCard label="Blocks" value={`${summary.blocks}`} />
          <StatCard label="Mean CPU Busy" value={`${figure(summary.meanCpuBusy, 1)}%`} />
          <StatCard label="Peak CPU Busy" value={`${figure(summary.peakCpuBusy, 1)}%`} />
          <StatCard label="Peak RAM Used" value={`${figure(summary.peakRamUsed, 1)} / ${figure(summary.ramTotal, 1)} GiB`} />
        </>
      }
      charts={
        <>
          {chart('CPU Busy %', chartOptions.cpuOption)}
          {chart('RAM Used (GiB)', chartOptions.ramOption)}
        </>
      }
      footer="Machine usage per block (ordered by execution) - mean series include idle nodes - drag slider to zoom"
    />
  )
}

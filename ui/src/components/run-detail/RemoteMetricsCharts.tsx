import { useCallback, useState } from 'react'
import type { DeviceMetrics, SuiteTest, TestEntry } from '@/api/types'
import type { TestStatusFilter } from './TestsTable'
import { useGpuMetricsSection } from './GpuMetricsCharts'
import { useNodeMetricsSection } from './NodeMetricsCharts'
import { RemoteMetricsPanel } from './RemoteMetricsPanel'

interface RemoteMetricsChartsProps {
  /** The node exporter artifact, absent from a run that collected none. */
  nodeMetrics?: DeviceMetrics | null
  /** The DCGM exporter artifact, absent from a run that collected none. */
  deviceMetrics?: DeviceMetrics | null
  /** Suite tests in canonical run order, so Test # matches the other charts. */
  suiteTests?: SuiteTest[]
  /** Only tests whose name matches this query are charted. */
  searchQuery?: string
  /** Test results, which carry the pass or fail state the status filter reads. */
  tests?: Record<string, TestEntry>
  statusFilter?: TestStatusFilter
  onTestClick?: (testName: string) => void
}

/**
 * RemoteMetricsCharts holds the machine and the GPU measurements of a run
 * under one heading, so the exporters of a rig read as one rig. Every chart
 * plots one point per block, and the blocks are the same on both sides. The
 * panel owns the zoom, so one drag moves every chart of it.
 */
export function RemoteMetricsCharts({ nodeMetrics, deviceMetrics, ...filters }: RemoteMetricsChartsProps) {
  const [zoomRange, setZoomRange] = useState({ start: 0, end: 100 })

  const onZoom = useCallback((start: number, end: number) => {
    setZoomRange({ start, end })
  }, [])

  const node = useNodeMetricsSection({ metrics: nodeMetrics, ...filters, zoomRange, onZoom })
  const gpu = useGpuMetricsSection({ metrics: deviceMetrics, ...filters, zoomRange, onZoom })
  const sections = [node, gpu].flatMap((section) => (section ? [section] : []))

  if (sections.length === 0) {
    return null
  }

  return (
    <RemoteMetricsPanel
      title="Remote Metrics"
      sources={sections.map((section) => section.source)}
      cards={
        <>
          {node?.cards}
          {gpu?.cards}
        </>
      }
      charts={
        <>
          {node?.charts}
          {gpu?.charts}
        </>
      }
      footer="Rig usage per block (ordered by execution) - mean series include idle devices - drag slider to zoom"
    />
  )
}

import { useCallback, useMemo, useState } from 'react'
import { useTestRemoteMetrics } from '@/api/hooks/useTestRemoteMetrics'
import { reduceGpuTraces, reduceNodeTraces, type TraceSeries, type TraceSummary } from '@/utils/testMetrics'
import { ChartSection, RemoteMetricsPanel, StatCard } from './RemoteMetricsPanel'
import { PERCENT_FLOOR, figure, useDarkMode, useTraceOptionBuilder } from './remoteMetricsChart'

/** A chart of the section, left out when the file lacks its column. */
type TraceChart = [title: string, series: TraceSeries[] | undefined, format: (v: number) => string, floor?: number]

const percent = (v: number) => `${v.toFixed(1)}%`
const gigabytesPerSecond = (v: number) => `${v.toFixed(2)} GB/s`

interface TestRemoteMetricsProps {
  runId: string
  testName: string
}

export function TestRemoteMetrics({ runId, testName }: TestRemoteMetricsProps) {
  const { data } = useTestRemoteMetrics(runId, testName)
  const isDark = useDarkMode()
  const [zoomRange, setZoomRange] = useState({ start: 0, end: 100 })

  const handleZoom = useCallback((start: number, end: number) => {
    setZoomRange({ start, end })
  }, [])

  const makeOption = useTraceOptionBuilder({ isDark, zoomRange })

  const gpu = useMemo(() => {
    const exporter = data?.exporters['dcgm-exporter']

    return exporter && reduceGpuTraces(exporter)
  }, [data])
  const node = useMemo(() => {
    const exporter = data?.exporters['node-exporter']

    return exporter && reduceNodeTraces(exporter)
  }, [data])

  const gpuCharts = useMemo(() => {
    if (!gpu) return []
    const charts: TraceChart[] = [
      ['GPU Power (W)', gpu.power, (v) => `${v.toFixed(0)} W`],
      ['SM Active %', gpu.smActive, percent, PERCENT_FLOOR],
      ['Integer Pipe Active %', gpu.intActive, percent, PERCENT_FLOOR],
      ['SM Occupancy %', gpu.smOccupancy, percent, PERCENT_FLOOR],
      ['DRAM Active %', gpu.dramActive, percent, PERCENT_FLOOR],
      ['PCIe RX (GB/s)', gpu.pcieRx, gigabytesPerSecond],
      ['PCIe TX (GB/s)', gpu.pcieTx, gigabytesPerSecond],
      ['Throttled Time %', gpu.throttled, percent, PERCENT_FLOOR],
      ['Temp Margin (°C)', gpu.tempMargin, (v) => `${v.toFixed(0)} °C`],
    ]

    return charts.flatMap(([title, series, format, floor]) => (series ? [{ title, option: makeOption(series, format, floor) }] : []))
  }, [gpu, makeOption])

  const nodeCharts = useMemo(() => {
    if (!node) return []
    const charts: TraceChart[] = [
      ['CPU Busy %', node.cpuBusy, percent, PERCENT_FLOOR],
      ['RAM Used (GiB)', node.ramUsedGiB, (v) => `${v.toFixed(1)} GiB`],
    ]

    return charts.flatMap(([title, series, format, floor]) => (series ? [{ title, option: makeOption(series, format, floor) }] : []))
  }, [node, makeOption])

  if (!data) {
    return null
  }

  const cards = (summary: TraceSummary, device: string) => (
    <>
      <StatCard label={`${device}s`} value={`${summary.devices}`} />
      <StatCard label={`Refreshes per ${device}`} value={figure(summary.meanRefreshes, 1)} />
      <StatCard label="Window" value={`${figure(summary.windowSeconds, 1)} s`} />
    </>
  )

  const charts = (list: Array<{ title: string; option: object }>) =>
    list.map(({ title, option }) => <ChartSection key={title} title={title} option={option} onZoom={handleZoom} />)

  return (
    <>
      {gpu && (
        <RemoteMetricsPanel
          title="Remote GPU Metrics"
          source="dcgm-exporter"
          sourceTitle="Counters and gauges scraped from the DCGM exporter on every node, one row per refresh inside this block's proving attempt"
          cards={cards(gpu.summary, 'GPU')}
          charts={charts(gpuCharts)}
          footer="GPU usage over this block's proving attempt - one line per GPU - click a legend entry to toggle its line - drag slider to zoom"
          embedded
        />
      )}
      {node && (
        <RemoteMetricsPanel
          title="Remote CPU/RAM Metrics"
          source="node-exporter"
          sourceTitle="Processor and memory counters scraped from the node exporter on every node, one row per refresh inside this block's proving attempt"
          cards={cards(node.summary, 'Node')}
          charts={charts(nodeCharts)}
          footer="Machine usage over this block's proving attempt - one line per node - click a legend entry to toggle its line - drag slider to zoom"
          embedded
        />
      )}
    </>
  )
}

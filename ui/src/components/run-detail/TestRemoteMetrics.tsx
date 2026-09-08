import { useCallback, useMemo, useState } from 'react'
import { useDeviceMetrics, useNodeMetrics } from '@/api/hooks/useRemoteMetrics'
import { useTestRemoteMetrics } from '@/api/hooks/useTestRemoteMetrics'
import { clockEventNames } from '@/utils/gpuMetrics'
import { cpuCoreCounts, cpuUsageFigure } from '@/utils/nodeMetrics'
import { higher, max } from '@/utils/remoteMetrics'
import { frameBufferTotals, reduceBlockMetrics, reduceGpuTraces, reduceNodeTraces, tracePeak, type TraceSeries } from '@/utils/testMetrics'
import { ChartSection, RemoteMetricsPanel, StatCard } from './RemoteMetricsPanel'
import { PERCENT_FLOOR, figure, useDarkMode, useTraceOptionBuilder, type Reference } from './remoteMetricsChart'

/** A chart of the section, left out when the file lacks its column. */
type TraceChart = [title: string, series: TraceSeries[] | undefined, format: (v: number) => string, floor?: number, limit?: Reference]

const percent = (v: number) => `${v.toFixed(1)}%`
const gigabytesPerSecond = (v: number) => `${v.toFixed(2)} GB/s`
const gibibytes = (v: number) => `${v.toFixed(1)} GiB`

/** The exporter every trace of a section came from, named in the header. */
const SOURCE = {
  node: {
    name: 'node-exporter',
    title: "Processor and memory counters scraped from the node exporter on every node, one row per refresh inside this block's proving attempt",
  },
  gpu: {
    name: 'dcgm-exporter',
    title: "Counters and gauges scraped from the DCGM exporter on every node, one row per refresh inside this block's proving attempt",
  },
} as const

interface TestRemoteMetricsProps {
  runId: string
  testName: string
}

/**
 * TestRemoteMetrics is the remote metrics tab of the test modal. It traces the
 * machines and the GPUs of the rig over the proving attempt of one block.
 */
export function TestRemoteMetrics({ runId, testName }: TestRemoteMetricsProps) {
  const { data } = useTestRemoteMetrics(runId, testName)
  const { data: nodeMetrics } = useNodeMetrics(runId)
  const { data: deviceMetrics } = useDeviceMetrics(runId)
  const isDark = useDarkMode()
  const [zoomRange, setZoomRange] = useState({ start: 0, end: 100 })

  const handleZoom = useCallback((start: number, end: number) => {
    setZoomRange({ start, end })
  }, [])

  const makeOption = useTraceOptionBuilder({ isDark, zoomRange })

  // The trace carries the busy share of each whole machine. The core counts
  // that turn it into the scale of the run charts ride on the run artifact.
  const cpuCores = useMemo(() => (nodeMetrics ? cpuCoreCounts(nodeMetrics) : {}), [nodeMetrics])
  // The axis tops out at the largest node, as the run chart does.
  const cpuScale = max(Object.values(cpuCores))

  // The run artifacts hold the rows of this test, so every card of the block
  // reads as the block's slice of its run card.
  const block = useMemo(() => reduceBlockMetrics(deviceMetrics, nodeMetrics, testName), [deviceMetrics, nodeMetrics, testName])
  // The trace holds no frame buffer total, so the limit of the used chart and
  // the headroom of each device come from the run artifact.
  const fbTotal = block.gpu?.fbTotal ?? null
  const fbTotals = useMemo(() => (deviceMetrics ? frameBufferTotals(deviceMetrics, testName) : {}), [deviceMetrics, testName])

  const gpu = useMemo(() => {
    const exporter = data?.exporters['dcgm-exporter']

    return exporter && reduceGpuTraces(exporter, fbTotals)
  }, [data, fbTotals])
  const node = useMemo(() => {
    const exporter = data?.exporters['node-exporter']

    return exporter && reduceNodeTraces(exporter, cpuCores)
  }, [data, cpuCores])

  const gpuCharts = useMemo(() => {
    if (!gpu) return []
    const charts: TraceChart[] = [
      ['GPU Power (W)', gpu.power, (v) => `${v.toFixed(0)} W`],
      ['SM Clock (MHz)', gpu.smClock, (v) => `${v.toFixed(0)} MHz`],
      ['SM Active %', gpu.smActive, percent, PERCENT_FLOOR],
      ['Integer Pipe Active %', gpu.intActive, percent, PERCENT_FLOOR],
      ['SM Occupancy %', gpu.smOccupancy, percent, PERCENT_FLOOR],
      ['DRAM Active %', gpu.dramActive, percent, PERCENT_FLOOR],
      ['Frame Buffer Used (GiB)', gpu.fbUsedGiB, gibibytes, undefined, fbTotal === null ? undefined : { value: fbTotal, label: 'total', wholeScale: true }],
      // No limit, so the axis keeps zero and the distance left to a full
      // frame buffer reads off it.
      ['Frame Buffer Margin (GiB)', gpu.fbMarginGiB, gibibytes],
      ['PCIe RX (GB/s)', gpu.pcieRx, gigabytesPerSecond],
      ['PCIe TX (GB/s)', gpu.pcieTx, gigabytesPerSecond],
      ['Throttled Time %', gpu.throttled, percent, PERCENT_FLOOR],
      ['Temp Margin (°C)', gpu.tempMargin, (v) => `${v.toFixed(0)} °C`],
    ]

    return charts.flatMap(([title, series, format, floor, limit]) => (series ? [{ title, option: makeOption(series, format, floor, limit) }] : []))
  }, [gpu, fbTotal, makeOption])

  const nodeCharts = useMemo(() => {
    if (!node) return []
    const charts: TraceChart[] = [
      // One fully busy processor reads 100 percent, so the axis tops out at
      // the processors of the node and the room under it is idle time.
      [
        'CPU Usage %',
        node.cpuBusy,
        cpuScale === null ? percent : (v) => `${v.toFixed(0)}%`,
        PERCENT_FLOOR,
        cpuScale === null ? undefined : { value: cpuScale * 100, label: `(${cpuScale} processors)`, wholeScale: true },
      ],
      ['RAM Used (GiB)', node.ramUsedGiB, gibibytes],
    ]

    return charts.flatMap(([title, series, format, floor, limit]) => (series ? [{ title, option: makeOption(series, format, floor, limit) }] : []))
  }, [node, cpuScale, makeOption])

  if (!data) {
    return null
  }

  const charts = (list: Array<{ title: string; option: object }>) =>
    list.map(({ title, option }) => <ChartSection key={title} title={title} option={option} onZoom={handleZoom} />)

  const windowSeconds = higher(node?.summary.windowSeconds ?? null, gpu?.summary.windowSeconds ?? null)
  const scrapes = higher(node?.summary.meanRefreshes ?? null, gpu?.summary.meanRefreshes ?? null)

  // A mean card reads the whole proving window, so the peak beside it reads
  // the busiest interval of the trace instead.
  const peakSmActive = tracePeak(gpu?.smActive)
  const peakCpuBusy = tracePeak(node?.cpuBusy)

  return (
    <RemoteMetricsPanel
      sources={[...(node ? [SOURCE.node] : []), ...(gpu ? [SOURCE.gpu] : [])]}
      cards={
        <>
          <StatCard label="Window" value={`${figure(windowSeconds, 1)} s, ${figure(scrapes, 0)} scrapes`} />
          {block.node && (
            <>
              <StatCard label="Mean CPU Usage" value={cpuUsageFigure(block.node.meanCpuBusy, block.node.cpuCores)} />
              <StatCard label="Peak CPU Usage" value={cpuUsageFigure(peakCpuBusy?.value ?? null, peakCpuBusy ? cpuCores[peakCpuBusy.name] : null)} />
              {block.node.ramTotal !== null && <StatCard label="Peak RAM Used" value={`${figure(block.node.peakRamUsed, 1)} / ${block.node.ramTotal} GiB`} />}
            </>
          )}
          {block.gpu && (
            <>
              <StatCard label="Mean SM Active" value={`${figure(block.gpu.meanSmActive, 1)}%`} />
              <StatCard label="Peak SM Active" value={`${figure(peakSmActive?.value ?? null, 1)}%`} />
              {block.hasPower && <StatCard label="Mean GPU Power" value={`${figure(block.gpu.meanWatts, 0)} W`} />}
              {block.gpu.powerLimit !== null && <StatCard label="Peak GPU Power" value={`${figure(block.gpu.peakWatts, 0)} / ${figure(block.gpu.powerLimit, 0)} W`} />}
              {block.gpu.fbTotal !== null && <StatCard label="Peak Frame Buffer" value={`${figure(block.gpu.peakFbUsed, 1)} / ${figure(block.gpu.fbTotal, 1)} GiB`} />}
              {block.hasPcieRate && <StatCard label="Peak PCIe Rate" value={`${figure(block.gpu.peakLink, 2)} GB/s`} />}
              {block.hasDuration && <StatCard label="Mean Throttled Time" value={`${figure(block.gpu.throttledShare, 1)}%`} />}
              <StatCard label="Min Temp Margin" value={`${figure(block.gpu.minTempMargin, 0)} °C`} />
              <StatCard label="PCIe Replays" value={figure(block.gpu.pcieReplays, 0)} />
              {block.hasSmClock && <StatCard label="Mean SM Clock" value={`${figure(block.gpu.meanSmClock, 0)} MHz`} />}
              {block.hasSmClock && <StatCard label="Min SM Clock" value={`${figure(block.gpu.minSmClock, 0)} MHz`} />}
              {block.hasSmClock && <StatCard label="Clock Events" value={block.gpu.clockEvents === null ? 'n/a' : clockEventNames(block.gpu.clockEvents).join(', ') || 'none'} />}
            </>
          )}
        </>
      }
      charts={
        <>
          {charts(nodeCharts)}
          {charts(gpuCharts)}
        </>
      }
      footer="Rig usage over this block's proving attempt - one line per device - click a legend entry to toggle its line - drag slider to zoom"
      embedded
    />
  )
}

import type { DeviceMetrics } from '@/api/types'
import { GAUGE_SCALE, LEADING, columnReader, higher, host, max, mean, orderedTests, scaled, type RemoteReductionOptions } from './remoteMetrics'

/**
 * Every metric column the node charts read. The collector writes exactly this
 * set, and a test on its side fails when the two drift apart.
 */
export const NODE_COLUMN = {
  cpuAll: 'node_cpu_seconds_total.total',
  cpuBusy: 'node_cpu_busy_seconds_total.total',
  memTotal: 'node_memory_MemTotal_bytes.max',
  memAvailableMean: 'node_memory_MemAvailable_bytes.mean',
  memAvailableMin: 'node_memory_MemAvailable_bytes.min',
} as const

const GIB = 1024 ** 3

/**
 * coreCount counts the processors of a node. A node counts one processor
 * second per second per processor, so the seconds it counted over the seconds
 * the block took give the count.
 */
export const coreCount = (cpuSeconds: number, durationMs: number) => Math.round(cpuSeconds / (durationMs / 1000))

/**
 * cpuUsageFigure reads a busy percent against the percent every processor of
 * the node gives together. A figure that spans more than one node, or a run
 * whose artifact carries no core count, has no single capacity to read against.
 */
export const cpuUsageFigure = (value: number | null, cores: number | null = null) =>
  value === null ? 'n/a' : cores === null ? `${value.toFixed(1)}%` : `${value.toFixed(0)} / ${cores * 100} %`

/**
 * cpuCoreCounts reads the processor count of each node of one block, keyed by
 * the node label the per test traces name their series after, so every node
 * plots on the scale of its own machine. A node is absent when the artifact
 * does not carry the block, or when its row lacks the duration the count is
 * measured against.
 */
export function cpuCoreCounts(metrics: DeviceMetrics, testName: string): Record<string, number> {
  const { cell } = columnReader(metrics)
  const counts: Record<string, number> = {}

  for (const rows of Object.values(metrics.tests[testName] ?? {})) {
    for (const row of rows) {
      const device = cell(row, LEADING.device)
      const durationMs = cell(row, LEADING.durationMs) ?? 0
      const seconds = cell(row, NODE_COLUMN.cpuAll)
      if (device === null || seconds === null || durationMs <= 0) continue

      counts[host(metrics.devices[device])] = coreCount(seconds / GAUGE_SCALE, durationMs)
    }
  }

  return counts
}

/**
 * NodeDataPoint holds one block reduced across every node that reported it.
 *
 * CPU busy is the busy processor seconds of a node against the seconds one
 * processor of it could give, so a node with 32 cores fully busy reads 3200
 * percent. The mean is the mean over the nodes and the busiest figure follows
 * the single hardest working node. A measured figure is null when no node of
 * the block carries it.
 */
export interface NodeDataPoint {
  testIndex: number
  testNumber: number
  testName: string
  devices: number
  cpuBusy: number | null
  busiestCpuBusy: number | null
  ramUsedGiB: number | null
  peakRamUsedGiB: number | null
  ramTotalGiB: number | null
}

export interface NodeSummary {
  devices: number
  blocks: number
  /** Mean processor busy time over the blocks, each weighted by the time it took. */
  meanCpuBusy: number | null
  /** Processors of every node when they all count the same, which is the capacity the mean reads against. */
  meanCpuCores: number | null
  peakCpuBusy: number | null
  /** Processors of the node the peak came from, which is the capacity it reads against. */
  peakCpuCores: number | null
  /** Processors of the largest node, which is the top of the CPU scale. */
  cpuCores: number | null
  peakRamUsed: number | null
  ramTotal: number | null
}

export interface NodeMetricsView {
  dataPoints: NodeDataPoint[]
  summary: NodeSummary
}

export function reduceNodeMetrics(metrics: DeviceMetrics, options: RemoteReductionOptions = {}): NodeMetricsView {
  const { cell, measured } = columnReader(metrics)
  const { names, order } = orderedTests(metrics, options)

  const points: NodeDataPoint[] = []
  const summary: NodeSummary = {
    devices: metrics.devices.length,
    blocks: 0,
    meanCpuBusy: null,
    meanCpuCores: null,
    peakCpuBusy: null,
    peakCpuCores: null,
    cpuCores: null,
    peakRamUsed: null,
    ramTotal: null,
  }
  const coreCounts = new Set<number>()
  let cpuTotal = 0
  let cpuWeight = 0

  for (const testName of names) {
    for (const rows of Object.values(metrics.tests[testName])) {
      if (rows.length === 0) continue

      // A block weighs the time it took, so a long block is not averaged away
      // by a short one. An artifact without the duration column weighs one.
      const durationMs = cell(rows[0], LEADING.durationMs) ?? 0
      const weight = durationMs > 0 ? durationMs : 1

      // Busy processor seconds of a node against all of them, on the scale of
      // the resource charts, where one fully busy processor reads 100 percent.
      // An artifact without the duration column has no core count and reads
      // the share of the whole node instead.
      const cpu = rows.flatMap((row) => {
        const all = cell(row, NODE_COLUMN.cpuAll)
        const busy = cell(row, NODE_COLUMN.cpuBusy)
        if (all === null || all <= 0 || busy === null) return []
        const cores = durationMs > 0 ? coreCount(all / GAUGE_SCALE, durationMs) : null

        return [{ cores, percent: (busy / all) * (cores ?? 1) * 100 }]
      })
      const busyPercents = cpu.map((entry) => entry.percent)
      // The busiest node of the block, kept whole so that its percent stays
      // beside the processors of the same machine.
      const busiest = cpu.reduce<(typeof cpu)[number] | null>((top, entry) => (top === null || entry.percent > top.percent ? entry : top), null)

      // Used memory is what the kernel could not hand out, total less
      // available, read per node so that nodes of different sizes never mix.
      const used = (available: string) =>
        rows.flatMap((row) => {
          const total = cell(row, NODE_COLUMN.memTotal)
          const free = cell(row, available)

          return total !== null && free !== null ? [(total - free) / GAUGE_SCALE / GIB] : []
        })

      const point: NodeDataPoint = {
        testIndex: points.length + 1,
        testNumber: order.get(testName) ?? points.length + 1,
        testName,
        devices: rows.length,
        cpuBusy: mean(busyPercents),
        busiestCpuBusy: busiest === null ? null : busiest.percent,
        ramUsedGiB: mean(used(NODE_COLUMN.memAvailableMean)),
        peakRamUsedGiB: max(used(NODE_COLUMN.memAvailableMin)),
        ramTotalGiB: scaled(max(measured(rows, NODE_COLUMN.memTotal, GAUGE_SCALE)), 1 / GIB),
      }
      points.push(point)

      summary.blocks++
      if (point.cpuBusy !== null) {
        cpuTotal += point.cpuBusy * weight
        cpuWeight += weight
      }
      if (busiest !== null && (summary.peakCpuBusy === null || busiest.percent > summary.peakCpuBusy)) {
        summary.peakCpuBusy = busiest.percent
        summary.peakCpuCores = busiest.cores
      }
      for (const { cores } of cpu) if (cores !== null) coreCounts.add(cores)
      summary.peakRamUsed = higher(summary.peakRamUsed, point.peakRamUsedGiB)
      summary.ramTotal = higher(summary.ramTotal, point.ramTotalGiB)
    }
  }

  const cores = [...coreCounts]
  if (cpuWeight > 0) summary.meanCpuBusy = cpuTotal / cpuWeight
  summary.cpuCores = max(cores)
  // A mean over the nodes reads against one capacity only where every node
  // counts the same processors.
  summary.meanCpuCores = cores.length === 1 ? cores[0] : null

  return { dataPoints: points, summary }
}

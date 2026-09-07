import type { DeviceMetrics } from '@/api/types'
import { GAUGE_SCALE, LEADING, agreed, columnReader, higher, host, max, mean, orderedTests, type RemoteReductionOptions } from './remoteMetrics'

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
 * cpuCoreCounts reads the processor count of each node, keyed by the node
 * label the per test traces name their series after. The count is measured
 * over every block of the node at once, because one block alone rounds off
 * by one where a scrape lands late. A node is absent when no row of it
 * carries the duration the count is measured against. Nodes that count
 * different processors share no scale, so they are all absent and the
 * figures read the share of each machine instead.
 */
export function cpuCoreCounts(metrics: DeviceMetrics): Record<string, number> {
  const { cell } = columnReader(metrics)
  const seconds: Record<string, number> = {}
  const durationMs: Record<string, number> = {}

  for (const blocks of Object.values(metrics.tests)) {
    for (const rows of Object.values(blocks)) {
      for (const row of rows) {
        const device = cell(row, LEADING.device)
        const duration = cell(row, LEADING.durationMs) ?? 0
        const counted = cell(row, NODE_COLUMN.cpuAll)
        if (device === null || counted === null || duration <= 0) continue

        const node = host(metrics.devices[device])
        seconds[node] = (seconds[node] ?? 0) + counted / GAUGE_SCALE
        durationMs[node] = (durationMs[node] ?? 0) + duration
      }
    }
  }

  const counts = Object.fromEntries(Object.keys(seconds).map((node) => [node, coreCount(seconds[node], durationMs[node])]))

  return agreed(Object.values(counts)) === null ? {} : counts
}

/**
 * NodeDataPoint holds one block reduced across every node that reported it.
 *
 * CPU busy is the busy processor seconds of a node against the seconds one
 * processor of it could give, so a node with 32 cores fully busy reads 3200
 * percent. Nodes that count different processors share no such scale, so a
 * rig of unequal machines reads the busy share of each whole node instead.
 * The mean is the mean over the nodes and the busiest figure follows the
 * single hardest working node. A measured figure is null when no node of the
 * block carries it.
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
}

export interface NodeSummary {
  devices: number
  blocks: number
  /** Mean processor busy time over the blocks, each weighted by the time it took. */
  meanCpuBusy: number | null
  maxMeanCpuBusy: number | null
  /** Processors of every node when they all count the same, which is the capacity the CPU figures read against. */
  cpuCores: number | null
  peakRamUsed: number | null
  /** RAM of every node to the GiB when they all carry the same, which is the capacity the peak reads against. */
  ramTotal: number | null
}

export interface NodeMetricsView {
  dataPoints: NodeDataPoint[]
  summary: NodeSummary
}

export function reduceNodeMetrics(metrics: DeviceMetrics, options: RemoteReductionOptions = {}): NodeMetricsView {
  const { cell, measured } = columnReader(metrics)
  const { names, order } = orderedTests(metrics, options)

  // Every capacity is read once over the whole run, because a figure of the
  // rig reads against one capacity only where every node carries the same.
  // The RAM total is read to whole GiB, because nodes of one model report
  // totals that differ by some MiB.
  const cpuCores = agreed(Object.values(cpuCoreCounts(metrics)))
  const allRows = Object.values(metrics.tests).flatMap((blocks) => Object.values(blocks).flat())
  const ramTotal = agreed(measured(allRows, NODE_COLUMN.memTotal, GAUGE_SCALE * GIB).map(Math.round))

  const points: NodeDataPoint[] = []
  const summary: NodeSummary = {
    devices: metrics.devices.length,
    blocks: 0,
    meanCpuBusy: null,
    maxMeanCpuBusy: null,
    cpuCores,
    peakRamUsed: null,
    ramTotal,
  }
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
      // A rig without one core count reads the share of the whole node instead.
      const busyPercents = rows.flatMap((row) => {
        const all = cell(row, NODE_COLUMN.cpuAll)
        const busy = cell(row, NODE_COLUMN.cpuBusy)

        return all === null || all <= 0 || busy === null ? [] : [(busy / all) * (cpuCores ?? 1) * 100]
      })

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
        busiestCpuBusy: max(busyPercents),
        ramUsedGiB: mean(used(NODE_COLUMN.memAvailableMean)),
        peakRamUsedGiB: max(used(NODE_COLUMN.memAvailableMin)),
      }
      points.push(point)

      summary.blocks++
      if (point.cpuBusy !== null) {
        cpuTotal += point.cpuBusy * weight
        cpuWeight += weight
      }
      summary.maxMeanCpuBusy = higher(summary.maxMeanCpuBusy, point.busiestCpuBusy)
      summary.peakRamUsed = higher(summary.peakRamUsed, point.peakRamUsedGiB)
    }
  }

  if (cpuWeight > 0) summary.meanCpuBusy = cpuTotal / cpuWeight

  return { dataPoints: points, summary }
}

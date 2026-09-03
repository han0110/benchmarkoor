import type { DeviceMetrics } from '@/api/types'
import { GAUGE_SCALE, columnReader, higher, max, mean, orderedTests, ratioPerDevice, scaled, type RemoteReductionOptions } from './remoteMetrics'

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
 * NodeDataPoint holds one block reduced across every node that reported it.
 *
 * CPU busy is the busy processor seconds of a node against all its processor
 * seconds, so it needs no core count. The mean is the mean over the nodes and
 * the busiest figure follows the single hardest working node. A measured
 * figure is null when no node of the block carries it.
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
  meanCpuBusy: number | null
  peakCpuBusy: number | null
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
    peakCpuBusy: null,
    peakRamUsed: null,
    ramTotal: null,
  }
  const cpuBlocks: number[] = []

  for (const testName of names) {
    for (const rows of Object.values(metrics.tests[testName])) {
      if (rows.length === 0) continue

      const cpu = ratioPerDevice(rows, cell, NODE_COLUMN.cpuBusy, NODE_COLUMN.cpuAll)

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
        cpuBusy: cpu.mean,
        busiestCpuBusy: cpu.busiest,
        ramUsedGiB: mean(used(NODE_COLUMN.memAvailableMean)),
        peakRamUsedGiB: max(used(NODE_COLUMN.memAvailableMin)),
        ramTotalGiB: scaled(max(measured(rows, NODE_COLUMN.memTotal, GAUGE_SCALE)), 1 / GIB),
      }
      points.push(point)

      summary.blocks++
      if (point.cpuBusy !== null) cpuBlocks.push(point.cpuBusy)
      summary.peakCpuBusy = higher(summary.peakCpuBusy, point.busiestCpuBusy)
      summary.peakRamUsed = higher(summary.peakRamUsed, point.peakRamUsedGiB)
      summary.ramTotal = higher(summary.ramTotal, point.ramTotalGiB)
    }
  }

  summary.meanCpuBusy = mean(cpuBlocks)

  return { dataPoints: points, summary }
}

import type { DeviceMetricDevice, DeviceMetrics, TestRemoteMetricsExporter } from '@/api/types'
import { reduceGpuMetrics, type GpuSummary } from './gpuMetrics'
import { reduceNodeMetrics, type NodeSummary } from './nodeMetrics'
import { GAUGE_SCALE, NO_METRICS, host, max, mean } from './remoteMetrics'

/** The instant column that leads every row, in milliseconds after the proving window started. */
const AT_MS = 'at_ms'

/**
 * Every metric column the GPU traces read. The collector writes exactly this
 * set, and a test on its side fails when the two drift apart.
 */
export const TRACE_COLUMN = {
  smActive: 'DCGM_FI_PROF_SM_CYCLES_ACTIVE_TOTAL.share',
  intActive: 'DCGM_FI_PROF_INT_CYCLES_ACTIVE_TOTAL.share',
  pcieRx: 'DCGM_FI_PROF_PCIE_RX_BYTES_TOTAL.rate',
  pcieTx: 'DCGM_FI_PROF_PCIE_TX_BYTES_TOTAL.rate',
  powerViolation: 'DCGM_FI_DEV_POWER_VIOLATION.rate',
  thermalViolation: 'DCGM_FI_DEV_THERMAL_VIOLATION.rate',
  power: 'DCGM_FI_DEV_POWER_USAGE.value',
  smOccupancy: 'DCGM_FI_PROF_SM_OCCUPANCY.value',
  dramActive: 'DCGM_FI_PROF_DRAM_ACTIVE.value',
  tempMargin: 'DCGM_FI_DEV_GPU_TEMP_MARGIN_CELSIUS.value',
} as const

/** Every metric column the node traces read, under the same contract. */
export const NODE_TRACE_COLUMN = {
  cpuBusy: 'node_cpu_busy_seconds_total.share',
  memAvailable: 'node_memory_MemAvailable_bytes.value',
  memTotal: 'node_memory_MemTotal_bytes.value',
} as const

const GIB = 1024 ** 3

/** One device as a line of [seconds, value] points. A null value breaks the line. */
export interface TraceSeries {
  name: string
  color: string
  data: Array<[number, number | null]>
}

export interface TraceSummary {
  devices: number
  /** Mean row count per device. */
  meanRefreshes: number | null
  /** The largest instant of any row, in seconds. */
  windowSeconds: number | null
}

/** The GPU charts, each absent when the file lacks a column it reads. */
export interface GpuTraces {
  summary: TraceSummary
  power?: TraceSeries[]
  smActive?: TraceSeries[]
  intActive?: TraceSeries[]
  smOccupancy?: TraceSeries[]
  dramActive?: TraceSeries[]
  pcieRx?: TraceSeries[]
  pcieTx?: TraceSeries[]
  throttled?: TraceSeries[]
  tempMargin?: TraceSeries[]
}

export interface NodeTraces {
  summary: TraceSummary
  cpuBusy?: TraceSeries[]
  ramUsedGiB?: TraceSeries[]
}

/** Four hues far apart on the wheel, one per node in the order of the sorted node labels. */
export const NODE_HUES = [217, 25, 142, 271]

/**
 * deviceColors gives the devices of a node one hue and spreads them over a
 * lightness range in the order of their gpu labels, so a node reads as a
 * colour family and a GPU within it as a shade.
 */
export function deviceColors(devices: DeviceMetricDevice[]): string[] {
  const nodes = [...new Set(devices.map(host))].sort()

  return devices.map((device) => {
    const siblings = devices
      .filter((other) => host(other) === host(device))
      .map((other) => Number(other.labels.gpu))
      .sort((a, b) => a - b)
    const position = siblings.indexOf(Number(device.labels.gpu))
    const lightness = siblings.length === 1 ? 50 : Math.round(35 + (35 * position) / (siblings.length - 1))

    return `hsl(${NODE_HUES[nodes.indexOf(host(device)) % NODE_HUES.length]}, 70%, ${lightness}%)`
  })
}

/**
 * traceReader addresses the cells of a per test artifact by column name and
 * builds one series per device. A chart over a column the file lacks is left
 * out, because a flat zero line reads as a measurement of nothing happening.
 * A null cell is a statistic without a base and becomes a gap in the line.
 */
function traceReader(exporter: TestRemoteMetricsExporter, name: (device: DeviceMetricDevice) => string) {
  const index = new Map(exporter.columns.map((column, position) => [column, position]))
  const at = index.get(AT_MS)!
  const colors = deviceColors(exporter.devices)
  // Devices sorted by node and then by gpu, so the legend reads in rig order
  // whatever order the scraper first saw them in.
  const order = exporter.devices
    .map((_, position) => position)
    .sort((a, b) => {
      const left = exporter.devices[a]
      const right = exporter.devices[b]

      return host(left).localeCompare(host(right)) || Number(left.labels.gpu ?? 0) - Number(right.labels.gpu ?? 0)
    })

  const trace = (columns: string[], value: (...cells: number[]) => number): TraceSeries[] | undefined => {
    const positions = columns.flatMap((column) => {
      const position = index.get(column)

      return position === undefined ? [] : [position]
    })
    if (positions.length < columns.length) return undefined

    return order.map((deviceIndex) => ({
      name: name(exporter.devices[deviceIndex]),
      color: colors[deviceIndex],
      data: exporter.samples[deviceIndex].map((row) => {
        const cells = positions.map((position) => row[position])

        return [row[at]! / 1000, cells.every((cell) => cell !== null) ? value(...(cells as number[])) : null]
      }),
    }))
  }

  const summary: TraceSummary = {
    devices: exporter.devices.length,
    meanRefreshes: mean(exporter.samples.map((rows) => rows.length)),
    windowSeconds: max(exporter.samples.flatMap((rows) => rows.map((row) => row[at]! / 1000))),
  }

  return { trace, summary }
}

// A share of two counters can pass one when a scrape lands between their
// refreshes, so it is capped where the collector caps it too.
const percent = (share: number) => Math.min(share / GAUGE_SCALE, 1) * 100
const gauge = (value: number) => value / GAUGE_SCALE
const gigabytesPerSecond = (rate: number) => rate / 1e9

export function reduceGpuTraces(exporter: TestRemoteMetricsExporter): GpuTraces {
  const { trace, summary } = traceReader(exporter, (device) => `${host(device)} gpu${device.labels.gpu}`)

  return {
    summary,
    power: trace([TRACE_COLUMN.power], gauge),
    smActive: trace([TRACE_COLUMN.smActive], percent),
    intActive: trace([TRACE_COLUMN.intActive], percent),
    smOccupancy: trace([TRACE_COLUMN.smOccupancy], percent),
    dramActive: trace([TRACE_COLUMN.dramActive], percent),
    pcieRx: trace([TRACE_COLUMN.pcieRx], gigabytesPerSecond),
    pcieTx: trace([TRACE_COLUMN.pcieTx], gigabytesPerSecond),
    // Power and heat can throttle the same instant, so the larger of the two
    // nanoseconds per second rates measures the share. A refresh can land
    // inside a shorter observed span, so the share is capped like the others.
    throttled: trace([TRACE_COLUMN.powerViolation, TRACE_COLUMN.thermalViolation], (power, thermal) => Math.min(Math.max(power, thermal) / 1e9, 1) * 100),
    tempMargin: trace([TRACE_COLUMN.tempMargin], gauge),
  }
}

/**
 * reduceNodeTraces reads the node trace of one block. CPU busy plots on the
 * scale of the run charts, where one fully busy processor reads 100 percent,
 * so it needs the core count of each node, keyed by node label. A node whose
 * core count is unknown reads the share of the whole machine instead.
 */
export function reduceNodeTraces(exporter: TestRemoteMetricsExporter, cpuCores: Record<string, number> = {}): NodeTraces {
  const { trace, summary } = traceReader(exporter, host)

  return {
    summary,
    // A series is named after the node it came from, so a rig of unequal
    // machines scales each line by the processors of that machine.
    cpuBusy: trace([NODE_TRACE_COLUMN.cpuBusy], percent)?.map((series) => {
      const cores = cpuCores[series.name] ?? 1

      return { ...series, data: series.data.map(([at, value]): [number, number | null] => [at, value === null ? null : value * cores]) }
    }),
    ramUsedGiB: trace([NODE_TRACE_COLUMN.memTotal, NODE_TRACE_COLUMN.memAvailable], (total, available) => (total - available) / GAUGE_SCALE / GIB),
  }
}

/**
 * tracePeak reads the highest interval any device of a trace reached, with the
 * device that reached it, so a figure read against the capacity of one machine
 * keeps the two together.
 */
export function tracePeak(series: TraceSeries[] | undefined) {
  const points = (series ?? []).flatMap(({ name, data }) => data.flatMap(([, value]) => (value === null ? [] : [{ name, value }])))

  return points.reduce<(typeof points)[number] | null>((top, point) => (top === null || point.value > top.value ? point : top), null)
}

/**
 * BlockMetrics holds one test of the run artifacts, the figures the cards of
 * the test modal read beside the peaks of its traces. Counters reduced over
 * the whole proving window give means and totals that samples cannot. A test
 * file can hold more than one block, so every figure pools all of them, as the
 * window and the traces of the modal do.
 */
export interface BlockMetrics {
  gpu: GpuSummary | null
  node: NodeSummary | null
  hasPower: boolean
  hasPcieRate: boolean
  hasDuration: boolean
}

export function reduceBlockMetrics(
  deviceMetrics: DeviceMetrics | null | undefined,
  nodeMetrics: DeviceMetrics | null | undefined,
  testName: string,
): BlockMetrics {
  const block = { includeTest: (name: string) => name === testName }
  const gpu = reduceGpuMetrics(deviceMetrics ?? NO_METRICS, block)
  const node = reduceNodeMetrics(nodeMetrics ?? NO_METRICS, block)

  return {
    gpu: gpu.summary.blocks > 0 ? gpu.summary : null,
    node: node.summary.blocks > 0 ? node.summary : null,
    hasPower: gpu.hasPower,
    hasPcieRate: gpu.hasPcieRate,
    hasDuration: gpu.hasDuration,
  }
}

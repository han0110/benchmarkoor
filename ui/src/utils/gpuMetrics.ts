import type { DeviceMetrics } from '@/api/types'
import {
  GAUGE_SCALE,
  LEADING,
  columnReader,
  higher,
  lower,
  max,
  mean,
  min,
  orderedTests,
  ratioPerDevice,
  scaled,
  sum,
  type RemoteReductionOptions,
} from './remoteMetrics'

export { GAUGE_SCALE } from './remoteMetrics'

/**
 * Every metric column the GPU charts read. The collector writes exactly this
 * set, and a test on its side fails when the two drift apart.
 */
export const COLUMN = {
  smElapsed: 'DCGM_FI_PROF_SM_CYCLES_ELAPSED_TOTAL.total',
  smActive: 'DCGM_FI_PROF_SM_CYCLES_ACTIVE_TOTAL.total',
  intActive: 'DCGM_FI_PROF_INT_CYCLES_ACTIVE_TOTAL.total',
  powerMean: 'DCGM_FI_DEV_POWER_USAGE.mean',
  powerMax: 'DCGM_FI_DEV_POWER_USAGE.max',
  powerLimit: 'DCGM_FI_DEV_ENFORCED_POWER_LIMIT.max',
  pcieTx: 'DCGM_FI_PROF_PCIE_TX_BYTES_TOTAL.rate_max',
  pcieRx: 'DCGM_FI_PROF_PCIE_RX_BYTES_TOTAL.rate_max',
  pcieReplay: 'DCGM_FI_DEV_PCIE_REPLAY_COUNTER.total',
  powerViolation: 'DCGM_FI_DEV_POWER_VIOLATION.total',
  thermalViolation: 'DCGM_FI_DEV_THERMAL_VIOLATION.total',
  dramActive: 'DCGM_FI_PROF_DRAM_ACTIVE.mean',
  smOccupancy: 'DCGM_FI_PROF_SM_OCCUPANCY.mean',
  fbUsed: 'DCGM_FI_DEV_FB_USED.max',
  fbTotal: 'DCGM_FI_DEV_FB_TOTAL.max',
  tempMargin: 'DCGM_FI_DEV_GPU_TEMP_MARGIN_CELSIUS.min',
} as const

/**
 * GpuDataPoint holds one block reduced across every GPU that reported it.
 *
 * The cluster proves one block at a time across all workers. A mean over the
 * GPUs therefore describes the rig, and an idle GPU is real data. The busiest
 * figures follow the single hardest working GPU, which the mean hides when a
 * small block runs on one GPU of sixteen. A measured figure is null when no
 * GPU of the block carries it.
 */
export interface GpuDataPoint {
  testIndex: number
  testNumber: number
  testName: string
  devices: number
  busyDevices: number
  smActive: number | null
  busiestSmActive: number | null
  intActive: number | null
  busiestIntActive: number | null
  dramActive: number | null
  busiestDramActive: number | null
  smOccupancy: number | null
  busiestSmOccupancy: number | null
  meanWatts: number | null
  peakWatts: number | null
  powerLimit: number | null
  pcieTxRate: number | null
  pcieRxRate: number | null
  /** Share of the block the worst GPU spent throttled by its power cap. */
  throttledPowerShare: number | null
  throttledThermalShare: number | null
  fbUsedGiB: number | null
  fbTotalGiB: number | null
  tempMargin: number | null
}

export interface GpuSummary {
  blocks: number
  /** Mean power over the blocks, each weighted by the time it took. */
  meanWatts: number | null
  peakWatts: number | null
  powerLimit: number | null
  /** Mean SM activity over the blocks, each weighted by the time it took. */
  meanSmActive: number | null
  peakSmActive: number | null
  peakFbUsed: number | null
  fbTotal: number | null
  peakLink: number | null
  minTempMargin: number | null
  /** Share of all GPU time in the run spent throttled, by power or by heat. */
  throttledShare: number | null
  pcieReplays: number | null
}

export interface GpuMetricsView {
  dataPoints: GpuDataPoint[]
  summary: GpuSummary
  hasPower: boolean
  hasPcieRate: boolean
  hasDuration: boolean
}

export type GpuReductionOptions = RemoteReductionOptions

export function reduceGpuMetrics(metrics: DeviceMetrics, options: GpuReductionOptions = {}): GpuMetricsView {
  const { has, cell, measured } = columnReader(metrics)
  const { names, order } = orderedTests(metrics, options)

  const points: GpuDataPoint[] = []
  const summary: GpuSummary = {
    blocks: 0,
    meanWatts: null,
    peakWatts: null,
    powerLimit: null,
    meanSmActive: null,
    peakSmActive: null,
    peakFbUsed: null,
    fbTotal: null,
    peakLink: null,
    minTempMargin: null,
    throttledShare: null,
    pcieReplays: null,
  }
  let smActiveTotal = 0
  let smActiveWeight = 0
  let wattsTotal = 0
  let wattsWeight = 0
  let throttledNs = 0
  let deviceNs = 0

  for (const testName of names) {
    for (const rows of Object.values(metrics.tests[testName])) {
      if (rows.length === 0) continue

      const sm = ratioPerDevice(rows, cell, COLUMN.smActive, COLUMN.smElapsed)
      const integer = ratioPerDevice(rows, cell, COLUMN.intActive, COLUMN.smElapsed)

      // Throttling is measured in nanoseconds held back, which only means
      // something against the time the block took.
      const durationMs = cell(rows[0], LEADING.durationMs) ?? 0
      const durationNs = durationMs * 1e6
      const worstShare = (name: string) => (durationNs > 0 ? scaled(max(measured(rows, name)), 100 / durationNs) : null)

      // A block weighs the time it took, so a long block is not averaged away
      // by a short one. An artifact without the duration column weighs one.
      const weight = durationMs > 0 ? durationMs : 1

      const dram = measured(rows, COLUMN.dramActive, GAUGE_SCALE / 100)
      const occupancy = measured(rows, COLUMN.smOccupancy, GAUGE_SCALE / 100)
      const rx = scaled(max(measured(rows, COLUMN.pcieRx)), 1e-9)
      const tx = scaled(max(measured(rows, COLUMN.pcieTx)), 1e-9)

      const point: GpuDataPoint = {
        testIndex: points.length + 1,
        testNumber: order.get(testName) ?? points.length + 1,
        testName,
        devices: rows.length,
        busyDevices: sm.busy,
        smActive: sm.mean,
        busiestSmActive: sm.busiest,
        intActive: integer.mean,
        busiestIntActive: integer.busiest,
        dramActive: mean(dram),
        busiestDramActive: max(dram),
        smOccupancy: mean(occupancy),
        busiestSmOccupancy: max(occupancy),
        meanWatts: mean(measured(rows, COLUMN.powerMean, GAUGE_SCALE)),
        peakWatts: max(measured(rows, COLUMN.powerMax, GAUGE_SCALE)),
        powerLimit: max(measured(rows, COLUMN.powerLimit, GAUGE_SCALE)),
        pcieTxRate: tx,
        pcieRxRate: rx,
        throttledPowerShare: worstShare(COLUMN.powerViolation),
        throttledThermalShare: worstShare(COLUMN.thermalViolation),
        fbUsedGiB: scaled(max(measured(rows, COLUMN.fbUsed, GAUGE_SCALE)), 1 / 1024),
        fbTotalGiB: scaled(max(measured(rows, COLUMN.fbTotal, GAUGE_SCALE)), 1 / 1024),
        tempMargin: min(measured(rows, COLUMN.tempMargin, GAUGE_SCALE)),
      }
      points.push(point)

      summary.blocks++
      if (point.smActive !== null) {
        smActiveTotal += point.smActive * weight
        smActiveWeight += weight
      }
      if (point.meanWatts !== null) {
        wattsTotal += point.meanWatts * weight
        wattsWeight += weight
      }
      summary.peakSmActive = higher(summary.peakSmActive, point.busiestSmActive)
      summary.peakWatts = higher(summary.peakWatts, point.peakWatts)
      summary.powerLimit = higher(summary.powerLimit, point.powerLimit)
      summary.peakLink = higher(summary.peakLink, higher(rx, tx))
      summary.peakFbUsed = higher(summary.peakFbUsed, point.fbUsedGiB)
      summary.fbTotal = higher(summary.fbTotal, point.fbTotalGiB)
      summary.minTempMargin = lower(summary.minTempMargin, point.tempMargin)
      const replays = measured(rows, COLUMN.pcieReplay)
      if (replays.length > 0) summary.pcieReplays = (summary.pcieReplays ?? 0) + sum(replays)

      // Power and heat can throttle the same instant, so the larger of the
      // two counters bounds the share at 100 percent.
      for (const row of rows) {
        const power = cell(row, COLUMN.powerViolation)
        const thermal = cell(row, COLUMN.thermalViolation)
        if (durationNs > 0 && (power !== null || thermal !== null)) {
          throttledNs += Math.max(power ?? 0, thermal ?? 0)
          deviceNs += durationNs
        }
      }
    }
  }

  if (smActiveWeight > 0) summary.meanSmActive = smActiveTotal / smActiveWeight
  if (wattsWeight > 0) summary.meanWatts = wattsTotal / wattsWeight
  if (deviceNs > 0) {
    summary.throttledShare = (throttledNs / deviceNs) * 100
  }

  return {
    dataPoints: points,
    summary,
    hasPower: has(COLUMN.powerLimit),
    hasPcieRate: has(COLUMN.pcieRx),
    hasDuration: has(LEADING.durationMs),
  }
}

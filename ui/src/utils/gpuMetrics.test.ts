import { describe, it, expect } from 'vitest'
import type { DeviceMetrics } from '@/api/types'
import { COLUMN, GAUGE_SCALE, reduceGpuMetrics } from './gpuMetrics'

const columns = [
  'device',
  'scrapes',
  'updates',
  'duration_ms',
  COLUMN.smElapsed,
  COLUMN.smActive,
  COLUMN.intActive,
  COLUMN.pcieTx,
  COLUMN.pcieRx,
  COLUMN.powerMean,
  COLUMN.powerMax,
  COLUMN.powerLimit,
  COLUMN.powerViolation,
  COLUMN.thermalViolation,
  COLUMN.pcieReplay,
  COLUMN.dramActive,
  COLUMN.smOccupancy,
  COLUMN.tempMargin,
  COLUMN.fbUsed,
  COLUMN.fbTotal,
]

type Row = Array<number | null>

function row(values: Record<string, number | null>): Row {
  return columns.map((column) => values[column] ?? null)
}

/** A copy of a row with some cells replaced. */
function withCells(source: Row, cells: Record<string, number | null>): Row {
  return row({ ...Object.fromEntries(columns.map((column, position) => [column, source[position]])), ...cells })
}

// One GPU proving for a second at 80 percent SM activity, a quarter of it
// throttled by the power cap, beside one GPU that sat idle.
const busy = row({
  device: 0,
  scrapes: 10,
  updates: 9,
  duration_ms: 1000,
  [COLUMN.smElapsed]: 1000,
  [COLUMN.smActive]: 800,
  [COLUMN.intActive]: 400,
  [COLUMN.pcieTx]: 1e9,
  [COLUMN.pcieRx]: 3e9,
  [COLUMN.powerMean]: 400 * GAUGE_SCALE,
  [COLUMN.powerMax]: 590 * GAUGE_SCALE,
  [COLUMN.powerLimit]: 600 * GAUGE_SCALE,
  [COLUMN.powerViolation]: 250e6,
  [COLUMN.thermalViolation]: 0,
  [COLUMN.pcieReplay]: 0,
  [COLUMN.dramActive]: 0.4 * GAUGE_SCALE,
  [COLUMN.smOccupancy]: 0.3 * GAUGE_SCALE,
  [COLUMN.tempMargin]: 10 * GAUGE_SCALE,
  [COLUMN.fbUsed]: 30720 * GAUGE_SCALE,
  [COLUMN.fbTotal]: 32768 * GAUGE_SCALE,
})

const idle = row({
  device: 1,
  scrapes: 10,
  updates: 9,
  duration_ms: 1000,
  [COLUMN.smElapsed]: 1000,
  [COLUMN.smActive]: 0,
  [COLUMN.intActive]: 0,
  [COLUMN.pcieTx]: 0,
  [COLUMN.pcieRx]: 0,
  [COLUMN.powerMean]: 20 * GAUGE_SCALE,
  [COLUMN.powerMax]: 25 * GAUGE_SCALE,
  [COLUMN.powerLimit]: 600 * GAUGE_SCALE,
  [COLUMN.powerViolation]: 0,
  [COLUMN.thermalViolation]: 0,
  [COLUMN.pcieReplay]: 0,
  [COLUMN.dramActive]: 0,
  [COLUMN.smOccupancy]: 0,
  [COLUMN.tempMargin]: 40 * GAUGE_SCALE,
  [COLUMN.fbUsed]: 1024 * GAUGE_SCALE,
  [COLUMN.fbTotal]: 32768 * GAUGE_SCALE,
})

const metrics: DeviceMetrics = {
  schemaVersion: 2,
  columns,
  devices: [
    { key: 'node1,gpu=0', labels: {} },
    { key: 'node1,gpu=1', labels: {} },
  ],
  tests: {
    'a.json': { '0x2': [busy] },
    'b.json': { '0x1': [busy, idle] },
  },
}

describe('reduceGpuMetrics', () => {
  it('separates the cluster mean from the busiest GPU', () => {
    const { dataPoints } = reduceGpuMetrics(metrics)
    const point = dataPoints.find((p) => p.testName === 'b.json')!

    expect(point.devices).toBe(2)
    expect(point.busyDevices).toBe(1)
    expect(point.smActive).toBeCloseTo(40)
    expect(point.busiestSmActive).toBeCloseTo(80)
    expect(point.intActive).toBeCloseTo(20)
    expect(point.busiestIntActive).toBeCloseTo(40)
    expect(point.dramActive).toBeCloseTo(20)
    expect(point.busiestDramActive).toBeCloseTo(40)
    expect(point.smOccupancy).toBeCloseTo(15)
    expect(point.busiestSmOccupancy).toBeCloseTo(30)
  })

  it('follows the hardest hit link and GPU', () => {
    const { dataPoints } = reduceGpuMetrics(metrics)
    const point = dataPoints.find((p) => p.testName === 'b.json')!

    expect(point.pcieRxRate).toBeCloseTo(3)
    expect(point.pcieTxRate).toBeCloseTo(1)
    expect(point.meanWatts).toBeCloseTo(210)
    expect(point.peakWatts).toBeCloseTo(590)
    expect(point.powerLimit).toBeCloseTo(600)
    expect(point.throttledPowerShare).toBeCloseTo(25)
    expect(point.throttledThermalShare).toBe(0)
    expect(point.tempMargin).toBeCloseTo(10)
    expect(point.fbUsedGiB).toBeCloseTo(30)
    expect(point.fbTotalGiB).toBeCloseTo(32)
    expect(point.refreshRatio).toBeCloseTo(100)
  })

  it('summarises the run over every block', () => {
    const { summary, hasPower, hasPcieRate, hasDuration } = reduceGpuMetrics(metrics)

    expect(hasPower && hasPcieRate && hasDuration).toBe(true)
    expect(summary.devices).toBe(2)
    expect(summary.blocks).toBe(2)
    expect(summary.meanSmActive).toBeCloseTo(60)
    expect(summary.peakSmActive).toBeCloseTo(80)
    expect(summary.meanWatts).toBeCloseTo(305)
    expect(summary.peakWatts).toBeCloseTo(590)
    expect(summary.powerLimit).toBeCloseTo(600)
    expect(summary.peakLink).toBeCloseTo(3)
    expect(summary.peakFbUsed).toBeCloseTo(30)
    expect(summary.fbTotal).toBeCloseTo(32)
    expect(summary.minTempMargin).toBeCloseTo(10)
    // Half a second throttled out of three GPU seconds.
    expect(summary.throttledShare).toBeCloseTo(100 / 6)
    expect(summary.pcieReplays).toBe(0)
    expect(summary.meanRefreshRatio).toBeCloseTo(100)
  })

  it('orders blocks as the suite ran them', () => {
    const { dataPoints } = reduceGpuMetrics(metrics, { suiteTests: [{ name: 'b.json' }, { name: 'a.json' }] })

    expect(dataPoints.map((p) => p.testName)).toEqual(['b.json', 'a.json'])
    expect(dataPoints.map((p) => p.testNumber)).toEqual([1, 2])
    expect(dataPoints.map((p) => p.testIndex)).toEqual([1, 2])
  })

  it('charts only the tests a search matches', () => {
    const { dataPoints, summary } = reduceGpuMetrics(metrics, { searchQuery: 'a.json' })

    expect(dataPoints.map((p) => p.testName)).toEqual(['a.json'])
    expect(summary.blocks).toBe(1)
  })

  it('charts only the tests the status filter keeps', () => {
    const { dataPoints } = reduceGpuMetrics(metrics, { includeTest: (name) => name === 'a.json' })

    expect(dataPoints.map((p) => p.testName)).toEqual(['a.json'])
  })

  it('treats an unmeasured cell as absent rather than zero', () => {
    const partial: DeviceMetrics = {
      ...metrics,
      tests: { 'b.json': { '0x1': [busy, withCells(idle, { [COLUMN.dramActive]: null, [COLUMN.intActive]: null })] } },
    }
    const { dataPoints } = reduceGpuMetrics(partial)

    expect(dataPoints[0].dramActive).toBeCloseTo(40)
    expect(dataPoints[0].intActive).toBeCloseTo(40)
    expect(dataPoints[0].smActive).toBeCloseTo(40)
  })

  it('weighs every GPU the same whatever its clock', () => {
    const fast = withCells(busy, { [COLUMN.smElapsed]: 2000, [COLUMN.smActive]: 2000 })
    const slow = withCells(idle, { [COLUMN.smElapsed]: 500, [COLUMN.smActive]: 0 })
    const { dataPoints } = reduceGpuMetrics({ ...metrics, tests: { 'b.json': { '0x1': [fast, slow] } } })

    expect(dataPoints[0].smActive).toBeCloseTo(50)
    expect(dataPoints[0].busiestSmActive).toBeCloseTo(100)
  })

  it('leaves a GPU whose elapsed counter did not move out of the ratios', () => {
    const unsampled = withCells(idle, { [COLUMN.smElapsed]: 0 })
    const { dataPoints } = reduceGpuMetrics({ ...metrics, tests: { 'b.json': { '0x1': [busy, unsampled] } } })

    expect(dataPoints[0].devices).toBe(2)
    expect(dataPoints[0].busyDevices).toBe(1)
    expect(dataPoints[0].smActive).toBeCloseTo(80)
    expect(dataPoints[0].busiestSmActive).toBeCloseTo(80)
  })

  it('leaves a figure unmeasured when no GPU of the block carries it', () => {
    const blank = { [COLUMN.dramActive]: null, [COLUMN.tempMargin]: null, [COLUMN.intActive]: null, [COLUMN.smActive]: null }
    const partial: DeviceMetrics = {
      ...metrics,
      tests: {
        'a.json': { '0x2': [busy] },
        'b.json': { '0x1': [withCells(busy, blank), withCells(idle, blank)] },
      },
    }
    const { dataPoints, summary } = reduceGpuMetrics(partial)
    const point = dataPoints.find((p) => p.testName === 'b.json')!

    expect(point.dramActive).toBeNull()
    expect(point.busiestDramActive).toBeNull()
    expect(point.tempMargin).toBeNull()
    expect(point.intActive).toBeNull()
    expect(point.busiestIntActive).toBeNull()
    expect(point.smActive).toBeNull()
    expect(point.busiestSmActive).toBeNull()
    expect(point.busyDevices).toBe(0)
    expect(summary.minTempMargin).toBeCloseTo(10)
    expect(summary.meanSmActive).toBeCloseTo(80)
  })

  it('reports the slowest refreshing GPU', () => {
    const stale = withCells(idle, { updates: 0 })
    const { dataPoints } = reduceGpuMetrics({ ...metrics, tests: { 'b.json': { '0x1': [busy, stale] } } })

    expect(dataPoints[0].refreshRatio).toBe(0)
  })

  it('bounds the throttled share when power and heat overlap', () => {
    const both = withCells(busy, { [COLUMN.powerViolation]: 1e9, [COLUMN.thermalViolation]: 1e9 })
    const { summary } = reduceGpuMetrics({ ...metrics, tests: { 'b.json': { '0x1': [both] } } })

    expect(summary.throttledShare).toBeCloseTo(100)
  })

  it('hides what an older artifact never measured', () => {
    const kept = new Set<string>([
      'device', 'scrapes', 'updates',
      COLUMN.smElapsed, COLUMN.smActive, COLUMN.intActive,
      COLUMN.powerViolation, COLUMN.thermalViolation, COLUMN.pcieReplay,
      COLUMN.dramActive, COLUMN.smOccupancy, COLUMN.tempMargin, COLUMN.fbUsed, COLUMN.fbTotal,
    ])
    const keep = columns.map((c, i) => [c, i] as const).filter(([c]) => kept.has(c))
    const older: DeviceMetrics = {
      ...metrics,
      columns: keep.map(([c]) => c),
      tests: { 'b.json': { '0x1': [busy, idle].map((r) => keep.map(([, i]) => r[i])) } },
    }
    const view = reduceGpuMetrics(older)

    expect(view.hasPower).toBe(false)
    expect(view.hasPcieRate).toBe(false)
    expect(view.hasDuration).toBe(false)
    expect(view.dataPoints[0].smActive).toBeCloseTo(40)
    expect(view.dataPoints[0].throttledPowerShare).toBeNull()
    expect(view.dataPoints[0].meanWatts).toBeNull()
    expect(view.summary.throttledShare).toBeNull()
    expect(view.summary.meanWatts).toBeNull()
  })

  it('leaves the replay count unmeasured when no row carries it', () => {
    const blank = { [COLUMN.pcieReplay]: null }
    const { summary } = reduceGpuMetrics({ ...metrics, tests: { 'b.json': { '0x1': [withCells(busy, blank), withCells(idle, blank)] } } })

    expect(summary.pcieReplays).toBeNull()
  })
})

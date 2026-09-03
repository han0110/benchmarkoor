import { describe, it, expect } from 'vitest'
import type { DeviceMetrics } from '@/api/types'
import { GAUGE_SCALE } from './remoteMetrics'
import { NODE_COLUMN, reduceNodeMetrics } from './nodeMetrics'

const GIB = 1024 ** 3

const columns = ['device', 'scrapes', 'updates', 'duration_ms', NODE_COLUMN.cpuAll, NODE_COLUMN.cpuBusy, NODE_COLUMN.memTotal, NODE_COLUMN.memAvailableMean, NODE_COLUMN.memAvailableMin]

function row(values: Record<string, number | null>): Array<number | null> {
  return columns.map((column) => values[column] ?? null)
}

// A 64 core node fully busy for two seconds beside an idle one, both with
// 128 GiB of which 32 GiB is in use on average and 40 GiB at the peak.
const busy = row({
  device: 0,
  scrapes: 20,
  updates: 19,
  duration_ms: 2000,
  [NODE_COLUMN.cpuAll]: 128,
  [NODE_COLUMN.cpuBusy]: 128,
  [NODE_COLUMN.memTotal]: 128 * GIB * GAUGE_SCALE,
  [NODE_COLUMN.memAvailableMean]: 96 * GIB * GAUGE_SCALE,
  [NODE_COLUMN.memAvailableMin]: 88 * GIB * GAUGE_SCALE,
})

const idle = row({
  device: 1,
  scrapes: 20,
  updates: 19,
  duration_ms: 2000,
  [NODE_COLUMN.cpuAll]: 128,
  [NODE_COLUMN.cpuBusy]: 0,
  [NODE_COLUMN.memTotal]: 128 * GIB * GAUGE_SCALE,
  [NODE_COLUMN.memAvailableMean]: 120 * GIB * GAUGE_SCALE,
  [NODE_COLUMN.memAvailableMin]: 120 * GIB * GAUGE_SCALE,
})

const metrics: DeviceMetrics = {
  schemaVersion: 2,
  columns,
  devices: [
    { key: 'node1', labels: { node: 'node1' } },
    { key: 'node2', labels: { node: 'node2' } },
  ],
  tests: { 'a.json': { '0x1': [busy, idle] } },
}

describe('reduceNodeMetrics', () => {
  it('reads processor busy time as a share of all processor time', () => {
    const { dataPoints, summary } = reduceNodeMetrics(metrics)

    expect(dataPoints[0].devices).toBe(2)
    expect(dataPoints[0].cpuBusy).toBeCloseTo(50)
    expect(dataPoints[0].busiestCpuBusy).toBeCloseTo(100)
    expect(summary.meanCpuBusy).toBeCloseTo(50)
    expect(summary.peakCpuBusy).toBeCloseTo(100)
  })

  it('weighs every node the same whatever its core count', () => {
    const big = row({ ...Object.fromEntries(columns.map((c, i) => [c, busy[i]])), [NODE_COLUMN.cpuAll]: 256, [NODE_COLUMN.cpuBusy]: 256 })
    const small = row({ ...Object.fromEntries(columns.map((c, i) => [c, idle[i]])), [NODE_COLUMN.cpuAll]: 16, [NODE_COLUMN.cpuBusy]: 0 })
    const { dataPoints } = reduceNodeMetrics({ ...metrics, tests: { 'a.json': { '0x1': [big, small] } } })

    expect(dataPoints[0].cpuBusy).toBeCloseTo(50)
    expect(dataPoints[0].busiestCpuBusy).toBeCloseTo(100)
  })

  it('reads used memory per node as total less available', () => {
    const { dataPoints, summary } = reduceNodeMetrics(metrics)

    expect(dataPoints[0].ramUsedGiB).toBeCloseTo(20)
    expect(dataPoints[0].peakRamUsedGiB).toBeCloseTo(40)
    expect(dataPoints[0].ramTotalGiB).toBeCloseTo(128)
    expect(summary.peakRamUsed).toBeCloseTo(40)
    expect(summary.ramTotal).toBeCloseTo(128)
  })

  it('leaves a figure unmeasured when no node of the block carries it', () => {
    const blank = (source: Array<number | null>) =>
      row({ ...Object.fromEntries(columns.map((c, i) => [c, source[i]])), [NODE_COLUMN.cpuBusy]: null, [NODE_COLUMN.memAvailableMin]: null })
    const { dataPoints } = reduceNodeMetrics({ ...metrics, tests: { 'a.json': { '0x1': [blank(busy), blank(idle)] } } })

    expect(dataPoints[0].cpuBusy).toBeNull()
    expect(dataPoints[0].busiestCpuBusy).toBeNull()
    expect(dataPoints[0].peakRamUsedGiB).toBeNull()
    expect(dataPoints[0].ramUsedGiB).toBeCloseTo(20)
  })

  it('charts only the tests the page filters keep', () => {
    const two: DeviceMetrics = { ...metrics, tests: { 'a.json': { '0x1': [busy] }, 'b.json': { '0x2': [idle] } } }

    expect(reduceNodeMetrics(two, { searchQuery: 'b.json' }).dataPoints.map((p) => p.testName)).toEqual(['b.json'])
    expect(reduceNodeMetrics(two, { includeTest: (name) => name === 'a.json' }).summary.blocks).toBe(1)
    expect(reduceNodeMetrics(two, { suiteTests: [{ name: 'b.json' }, { name: 'a.json' }] }).dataPoints.map((p) => p.testNumber)).toEqual([1, 2])
  })
})

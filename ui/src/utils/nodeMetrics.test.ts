import { describe, it, expect } from 'vitest'
import type { DeviceMetrics } from '@/api/types'
import { GAUGE_SCALE } from './remoteMetrics'
import { NODE_COLUMN, cpuCoreCounts, cpuUsageFigure, reduceNodeMetrics } from './nodeMetrics'

const GIB = 1024 ** 3

/** The processor seconds a node of this core count counts over these seconds. */
const cpuSeconds = (cores: number, seconds: number) => cores * seconds * GAUGE_SCALE

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
  [NODE_COLUMN.cpuAll]: cpuSeconds(64, 2),
  [NODE_COLUMN.cpuBusy]: cpuSeconds(64, 2),
  [NODE_COLUMN.memTotal]: 128 * GIB * GAUGE_SCALE,
  [NODE_COLUMN.memAvailableMean]: 96 * GIB * GAUGE_SCALE,
  [NODE_COLUMN.memAvailableMin]: 88 * GIB * GAUGE_SCALE,
})

const idle = row({
  device: 1,
  scrapes: 20,
  updates: 19,
  duration_ms: 2000,
  [NODE_COLUMN.cpuAll]: cpuSeconds(64, 2),
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

/** A copy of a row with some of its cells replaced. */
const rewrite = (source: Array<number | null>, values: Record<string, number | null>) =>
  row({ ...Object.fromEntries(columns.map((column, index) => [column, source[index]])), ...values })

// The same block on a rig of unequal machines, a busy 128 core node beside an
// idle 8 core one.
const unequal: DeviceMetrics = {
  ...metrics,
  tests: {
    'a.json': {
      '0x1': [
        rewrite(busy, { [NODE_COLUMN.cpuAll]: cpuSeconds(128, 2), [NODE_COLUMN.cpuBusy]: cpuSeconds(128, 2) }),
        rewrite(idle, { [NODE_COLUMN.cpuAll]: cpuSeconds(8, 2), [NODE_COLUMN.cpuBusy]: 0 }),
      ],
    },
  },
}

describe('reduceNodeMetrics', () => {
  it('reads processor busy time on the scale of one fully busy processor', () => {
    const { dataPoints, summary } = reduceNodeMetrics(metrics)

    expect(dataPoints[0].devices).toBe(2)
    expect(dataPoints[0].cpuBusy).toBeCloseTo(3200)
    expect(dataPoints[0].busiestCpuBusy).toBeCloseTo(6400)
    expect(summary.meanCpuBusy).toBeCloseTo(3200)
    expect(summary.maxMeanCpuBusy).toBeCloseTo(6400)
    expect(summary.cpuCores).toBe(64)
  })

  it('reads the share of each node when the nodes count different processors', () => {
    const { dataPoints, summary } = reduceNodeMetrics(unequal)

    expect(dataPoints[0].cpuBusy).toBeCloseTo(50)
    expect(dataPoints[0].busiestCpuBusy).toBeCloseTo(100)
    expect(summary.maxMeanCpuBusy).toBeCloseTo(100)
    expect(summary.cpuCores).toBeNull()
  })

  it('reads the share of the whole node when the artifact has no duration', () => {
    const undated = columns.filter((column) => column !== 'duration_ms')
    const strip = (source: Array<number | null>) => columns.flatMap((column, index) => (column === 'duration_ms' ? [] : [source[index]]))
    const { dataPoints, summary } = reduceNodeMetrics({ ...metrics, columns: undated, tests: { 'a.json': { '0x1': [strip(busy), strip(idle)] } } })

    expect(dataPoints[0].cpuBusy).toBeCloseTo(50)
    expect(dataPoints[0].busiestCpuBusy).toBeCloseTo(100)
    expect(summary.cpuCores).toBeNull()
  })

  it('reads used memory per node as total less available', () => {
    const { dataPoints, summary } = reduceNodeMetrics(metrics)

    expect(dataPoints[0].ramUsedGiB).toBeCloseTo(20)
    expect(dataPoints[0].peakRamUsedGiB).toBeCloseTo(40)
    expect(summary.peakRamUsed).toBeCloseTo(40)
    expect(summary.ramTotal).toBeCloseTo(128)
  })

  it('reads the RAM total to the GiB, only where every node carries the same', () => {
    const total = (gib: number) => ({ ...metrics, tests: { 'a.json': { '0x1': [busy, rewrite(idle, { [NODE_COLUMN.memTotal]: gib * GIB * GAUGE_SCALE })] } } })

    expect(reduceNodeMetrics(total(128.2)).summary.ramTotal).toBe(128)
    expect(reduceNodeMetrics(total(256)).summary.ramTotal).toBeNull()
  })

  it('leaves a figure unmeasured when no node of the block carries it', () => {
    const blank = (source: Array<number | null>) => rewrite(source, { [NODE_COLUMN.cpuBusy]: null, [NODE_COLUMN.memAvailableMin]: null })
    const { dataPoints } = reduceNodeMetrics({ ...metrics, tests: { 'a.json': { '0x1': [blank(busy), blank(idle)] } } })

    expect(dataPoints[0].cpuBusy).toBeNull()
    expect(dataPoints[0].busiestCpuBusy).toBeNull()
    expect(dataPoints[0].peakRamUsedGiB).toBeNull()
    expect(dataPoints[0].ramUsedGiB).toBeCloseTo(20)
  })

  it('weighs a block by the time it took', () => {
    const long = rewrite(busy, { duration_ms: 6000, [NODE_COLUMN.cpuAll]: cpuSeconds(64, 6), [NODE_COLUMN.cpuBusy]: cpuSeconds(64, 6) })
    const { summary } = reduceNodeMetrics({ ...metrics, tests: { 'a.json': { '0x1': [busy, idle] }, 'b.json': { '0x2': [long] } } })

    expect(summary.meanCpuBusy).toBeCloseTo(5600)
  })

  it('charts only the tests the page filters keep', () => {
    const two: DeviceMetrics = { ...metrics, tests: { 'a.json': { '0x1': [busy] }, 'b.json': { '0x2': [idle] } } }

    expect(reduceNodeMetrics(two, { searchQuery: 'b.json' }).dataPoints.map((p) => p.testName)).toEqual(['b.json'])
    expect(reduceNodeMetrics(two, { includeTest: (name) => name === 'a.json' }).summary.blocks).toBe(1)
    expect(reduceNodeMetrics(two, { suiteTests: [{ name: 'b.json' }, { name: 'a.json' }] }).dataPoints.map((p) => p.testNumber)).toEqual([1, 2])
  })
})

describe('cpuCoreCounts', () => {
  it('counts the processors of each node, only where every node counts the same', () => {
    expect(cpuCoreCounts(metrics)).toEqual({ node1: 64, node2: 64 })
    expect(cpuCoreCounts(unequal)).toEqual({})
  })

  it('counts over every block, so one late scrape does not round a node off by one', () => {
    const late = rewrite(busy, { [NODE_COLUMN.cpuAll]: cpuSeconds(63.4, 2), [NODE_COLUMN.cpuBusy]: cpuSeconds(63.4, 2) })
    const twoBlocks = { ...metrics, tests: { 'a.json': { '0x1': [late, idle] }, 'b.json': { '0x2': [busy, idle] } } }

    expect(cpuCoreCounts(twoBlocks)).toEqual({ node1: 64, node2: 64 })
    expect(reduceNodeMetrics(twoBlocks).summary.cpuCores).toBe(64)
  })
})

describe('cpuUsageFigure', () => {
  it('reads the busy percent against the percent every processor gives', () => {
    expect(cpuUsageFigure(697.4, 32)).toBe('697 / 3200 %')
    expect(cpuUsageFigure(49.53, null)).toBe('49.5%')
    expect(cpuUsageFigure(null, 32)).toBe('n/a')
  })
})

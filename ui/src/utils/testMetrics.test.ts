import { describe, it, expect } from 'vitest'
import type { DeviceMetrics, TestRemoteMetricsExporter } from '@/api/types'
import { COLUMN } from './gpuMetrics'
import { NODE_COLUMN } from './nodeMetrics'
import { GAUGE_SCALE, mean } from './remoteMetrics'
import { NODE_TRACE_COLUMN, TRACE_COLUMN, deviceColors, reduceBlockMetrics, reduceGpuTraces, reduceNodeTraces, tracePeak } from './testMetrics'

const GIB = 1024 ** 3

const gpuColumns = ['at_ms', ...Object.values(TRACE_COLUMN)]
const nodeColumns = ['at_ms', ...Object.values(NODE_TRACE_COLUMN)]

function row(columns: string[], values: Record<string, number | null>): Array<number | null> {
  return columns.map((column) => values[column] ?? null)
}

const gpuDevice = (node: string, gpu: string) => ({ key: `node=${node},gpu=${gpu}`, labels: { node, gpu } })

// Two GPUs on two nodes, listed in the order the scraper met them. The first
// refresh of the busy GPU carries no shares or rates yet, then it runs at 80
// percent SM activity, drawing 450 W and throttled a quarter of the time by
// its power cap. The other GPU sits idle and refreshes once. Series come out
// in rig order, so the idle node1 GPU leads and the busy node2 GPU follows.
const busyFirst = row(gpuColumns, { at_ms: 500, [TRACE_COLUMN.power]: 450 * GAUGE_SCALE, [TRACE_COLUMN.tempMargin]: 12 * GAUGE_SCALE })
const busy = row(gpuColumns, {
  at_ms: 1500,
  [TRACE_COLUMN.smActive]: 0.8 * GAUGE_SCALE,
  [TRACE_COLUMN.intActive]: 0.4 * GAUGE_SCALE,
  [TRACE_COLUMN.pcieRx]: 3e9,
  [TRACE_COLUMN.pcieTx]: 1e9,
  [TRACE_COLUMN.powerViolation]: 250e6,
  [TRACE_COLUMN.thermalViolation]: 0,
  [TRACE_COLUMN.power]: 450 * GAUGE_SCALE,
  [TRACE_COLUMN.smOccupancy]: 0.3 * GAUGE_SCALE,
  [TRACE_COLUMN.dramActive]: 0.4 * GAUGE_SCALE,
  [TRACE_COLUMN.tempMargin]: 10 * GAUGE_SCALE,
})
const idle = row(gpuColumns, {
  at_ms: 2000,
  [TRACE_COLUMN.smActive]: 0,
  [TRACE_COLUMN.intActive]: 0,
  [TRACE_COLUMN.pcieRx]: 0,
  [TRACE_COLUMN.pcieTx]: 0,
  [TRACE_COLUMN.powerViolation]: 0,
  [TRACE_COLUMN.thermalViolation]: 0,
  [TRACE_COLUMN.power]: 20 * GAUGE_SCALE,
  [TRACE_COLUMN.smOccupancy]: 0,
  [TRACE_COLUMN.dramActive]: 0,
  [TRACE_COLUMN.tempMargin]: 40 * GAUGE_SCALE,
})

const gpuExporter: TestRemoteMetricsExporter = {
  columns: gpuColumns,
  devices: [gpuDevice('node2', '3'), gpuDevice('node1', '0')],
  samples: [[busyFirst, busy], [idle]],
}

describe('reduceGpuTraces', () => {
  it('scales every column to the unit of its chart', () => {
    const traces = reduceGpuTraces(gpuExporter)
    const last = (series: ReturnType<typeof reduceGpuTraces>['power']) => series![1].data[1]

    expect(last(traces.power)).toEqual([1.5, 450])
    expect(last(traces.smActive)).toEqual([1.5, 80])
    expect(last(traces.intActive)).toEqual([1.5, 40])
    expect(last(traces.smOccupancy)).toEqual([1.5, 30])
    expect(last(traces.dramActive)).toEqual([1.5, 40])
    expect(last(traces.pcieRx)).toEqual([1.5, 3])
    expect(last(traces.pcieTx)).toEqual([1.5, 1])
    expect(last(traces.throttled)).toEqual([1.5, 25])
    expect(last(traces.tempMargin)).toEqual([1.5, 10])
  })

  it('breaks the line where a cell has no base', () => {
    const traces = reduceGpuTraces(gpuExporter)

    expect(traces.smActive![1].data).toEqual([[0.5, null], [1.5, 80]])
    expect(traces.throttled![1].data).toEqual([[0.5, null], [1.5, 25]])
    expect(traces.power![1].data).toEqual([[0.5, 450], [1.5, 450]])
  })

  it('names every GPU after its node and index, in rig order', () => {
    const traces = reduceGpuTraces(gpuExporter)

    expect(traces.power!.map((series) => series.name)).toEqual(['node1 gpu0', 'node2 gpu3'])
    expect(traces.power![0].data).toEqual([[2, 20]])
  })

  it('caps a share above the whole at 100 percent', () => {
    const torn = row(gpuColumns, { at_ms: 1500, [TRACE_COLUMN.smActive]: 25 * GAUGE_SCALE, [TRACE_COLUMN.powerViolation]: 1.25e9, [TRACE_COLUMN.thermalViolation]: 0 })
    const traces = reduceGpuTraces({ ...gpuExporter, samples: [[torn], [idle]] })

    expect(traces.smActive![1].data).toEqual([[1.5, 100]])
    expect(traces.throttled![1].data).toEqual([[1.5, 100]])
  })

  it('falls back to the device key when the configuration set no node label', () => {
    const unlabelled: TestRemoteMetricsExporter = {
      ...gpuExporter,
      devices: [{ key: 'host=a,gpu=3', labels: { host: 'a', gpu: '3' } }, { key: 'host=b,gpu=0', labels: { host: 'b', gpu: '0' } }],
    }
    const traces = reduceGpuTraces(unlabelled)

    expect(traces.power!.map((series) => series.name)).toEqual(['host=a,gpu=3 gpu3', 'host=b,gpu=0 gpu0'])
    expect(deviceColors(unlabelled.devices)).toHaveLength(2)
  })

  it('summarises the devices, their refreshes and the window', () => {
    const { summary } = reduceGpuTraces(gpuExporter)

    expect(summary.devices).toBe(2)
    expect(summary.meanRefreshes).toBeCloseTo(1.5)
    expect(summary.windowSeconds).toBeCloseTo(2)
  })

  it('leaves out a chart over a column an older file never wrote', () => {
    const dropped = new Set<string>([TRACE_COLUMN.thermalViolation, TRACE_COLUMN.tempMargin])
    const keep = gpuColumns.map((column, position) => [column, position] as const).filter(([column]) => !dropped.has(column))
    const older: TestRemoteMetricsExporter = {
      ...gpuExporter,
      columns: keep.map(([column]) => column),
      samples: gpuExporter.samples.map((rows) => rows.map((r) => keep.map(([, position]) => r[position]))),
    }
    const traces = reduceGpuTraces(older)

    expect(traces.throttled).toBeUndefined()
    expect(traces.tempMargin).toBeUndefined()
    expect(traces.smActive![1].data).toEqual([[0.5, null], [1.5, 80]])
  })
})

describe('reduceNodeTraces', () => {
  const nodeExporter: TestRemoteMetricsExporter = {
    columns: nodeColumns,
    devices: [{ key: 'node=node1', labels: { node: 'node1' } }],
    samples: [
      [
        row(nodeColumns, { at_ms: 400, [NODE_TRACE_COLUMN.memAvailable]: 96 * GIB * GAUGE_SCALE, [NODE_TRACE_COLUMN.memTotal]: 128 * GIB * GAUGE_SCALE }),
        row(nodeColumns, { at_ms: 1400, [NODE_TRACE_COLUMN.cpuBusy]: 0.75 * GAUGE_SCALE, [NODE_TRACE_COLUMN.memAvailable]: 88 * GIB * GAUGE_SCALE, [NODE_TRACE_COLUMN.memTotal]: 128 * GIB * GAUGE_SCALE }),
      ],
    ],
  }

  it('reads processor busy time on the core scale and used memory as total less available', () => {
    const traces = reduceNodeTraces(nodeExporter, { node1: 32 })

    expect(traces.cpuBusy![0].name).toBe('node1')
    expect(traces.cpuBusy![0].data).toEqual([[0.4, null], [1.4, 2400]])
    expect(traces.ramUsedGiB![0].data).toEqual([[0.4, 32], [1.4, 40]])
    expect(traces.summary).toEqual({ devices: 1, meanRefreshes: 2, windowSeconds: 1.4 })
  })

  it('plots every node against the processors of its own machine', () => {
    const unequal: TestRemoteMetricsExporter = {
      ...nodeExporter,
      devices: [...nodeExporter.devices, { key: 'node=node2', labels: { node: 'node2' } }],
      samples: [...nodeExporter.samples, nodeExporter.samples[0]],
    }
    const traces = reduceNodeTraces(unequal, { node1: 32, node2: 8 })

    expect(traces.cpuBusy!.map((series) => series.data[1])).toEqual([[1.4, 2400], [1.4, 600]])
  })

  it('leaves out used memory when the file lacks the total', () => {
    const withoutTotal: TestRemoteMetricsExporter = {
      ...nodeExporter,
      columns: nodeColumns.slice(0, 3),
      samples: nodeExporter.samples.map((rows) => rows.map((r) => r.slice(0, 3))),
    }

    expect(reduceNodeTraces(withoutTotal).ramUsedGiB).toBeUndefined()
    // Without a core count the trace reads the share of the whole node.
    expect(reduceNodeTraces(withoutTotal).cpuBusy![0].data).toEqual([[0.4, null], [1.4, 75]])
  })
})

describe('tracePeak', () => {
  it('reads the busiest interval of a trace, above the mean of its intervals', () => {
    const { smActive } = reduceGpuTraces(gpuExporter)
    const intervals = smActive!.flatMap((series) => series.data.flatMap(([, value]) => (value === null ? [] : [value])))

    expect(tracePeak(smActive)).toEqual({ name: 'node2 gpu3', value: 80 })
    expect(mean(intervals)).toBeCloseTo(40)
  })

  it('leaves the card unmeasured when the file lacks the column', () => {
    expect(tracePeak(undefined)).toBeNull()
  })
})

describe('reduceBlockMetrics', () => {
  const deviceColumns = [
    'device',
    'duration_ms',
    COLUMN.smElapsed,
    COLUMN.smActive,
    COLUMN.powerMean,
    COLUMN.powerLimit,
    COLUMN.powerViolation,
    COLUMN.pcieReplay,
    COLUMN.pcieRx,
    COLUMN.fbUsed,
    COLUMN.fbTotal,
    COLUMN.tempMargin,
  ]
  const nodeArtifactColumns = ['device', 'duration_ms', NODE_COLUMN.cpuAll, NODE_COLUMN.cpuBusy, NODE_COLUMN.memTotal, NODE_COLUMN.memAvailableMean, NODE_COLUMN.memAvailableMin]

  // One GPU proving for a second at 80 percent SM activity, a quarter of it
  // throttled by the power cap, beside one GPU that sat idle.
  const busyGpu = row(deviceColumns, {
    device: 0,
    duration_ms: 1000,
    [COLUMN.smElapsed]: 1000,
    [COLUMN.smActive]: 800,
    [COLUMN.powerMean]: 400 * GAUGE_SCALE,
    [COLUMN.powerLimit]: 600 * GAUGE_SCALE,
    [COLUMN.powerViolation]: 250e6,
    [COLUMN.pcieReplay]: 2,
    [COLUMN.pcieRx]: 3e9,
    [COLUMN.fbUsed]: 30720 * GAUGE_SCALE,
    [COLUMN.fbTotal]: 32768 * GAUGE_SCALE,
    [COLUMN.tempMargin]: 10 * GAUGE_SCALE,
  })
  const idleGpu = row(deviceColumns, {
    device: 1,
    duration_ms: 1000,
    [COLUMN.smElapsed]: 1000,
    [COLUMN.smActive]: 0,
    [COLUMN.powerMean]: 20 * GAUGE_SCALE,
    [COLUMN.powerLimit]: 600 * GAUGE_SCALE,
    [COLUMN.powerViolation]: 0,
    [COLUMN.pcieReplay]: 0,
    [COLUMN.pcieRx]: 0,
    [COLUMN.fbUsed]: 1024 * GAUGE_SCALE,
    [COLUMN.fbTotal]: 32768 * GAUGE_SCALE,
    [COLUMN.tempMargin]: 40 * GAUGE_SCALE,
  })

  // A second block of the same test file, three times as long, at 20 percent
  // SM activity and never throttled.
  const slowGpu = row(deviceColumns, {
    device: 0,
    duration_ms: 3000,
    [COLUMN.smElapsed]: 3000,
    [COLUMN.smActive]: 600,
    [COLUMN.powerMean]: 100 * GAUGE_SCALE,
    [COLUMN.powerLimit]: 600 * GAUGE_SCALE,
    [COLUMN.powerViolation]: 0,
    [COLUMN.pcieReplay]: 4,
    [COLUMN.pcieRx]: 1e9,
    [COLUMN.fbUsed]: 2048 * GAUGE_SCALE,
    [COLUMN.fbTotal]: 32768 * GAUGE_SCALE,
    [COLUMN.tempMargin]: 20 * GAUGE_SCALE,
  })

  const deviceMetrics: DeviceMetrics = {
    schemaVersion: 2,
    columns: deviceColumns,
    devices: [gpuDevice('node1', '0'), gpuDevice('node1', '1')],
    tests: { 'a.json': { '0x2': [busyGpu] }, 'b.json': { '0x1': [busyGpu, idleGpu] } },
  }

  // A 32 core node half busy for the second, with 128 GiB of which 32 GiB is
  // in use on average and 40 GiB at the peak.
  const nodeMetrics: DeviceMetrics = {
    schemaVersion: 2,
    columns: nodeArtifactColumns,
    devices: [{ key: 'node=node1', labels: { node: 'node1' } }],
    tests: {
      'b.json': {
        '0x1': [
          row(nodeArtifactColumns, {
            device: 0,
            duration_ms: 1000,
            [NODE_COLUMN.cpuAll]: 32 * GAUGE_SCALE,
            [NODE_COLUMN.cpuBusy]: 16 * GAUGE_SCALE,
            [NODE_COLUMN.memTotal]: 128 * GIB * GAUGE_SCALE,
            [NODE_COLUMN.memAvailableMean]: 96 * GIB * GAUGE_SCALE,
            [NODE_COLUMN.memAvailableMin]: 88 * GIB * GAUGE_SCALE,
          }),
        ],
      },
    },
  }

  it('reads the one block the modal shows', () => {
    const block = reduceBlockMetrics(deviceMetrics, nodeMetrics, 'b.json')

    expect(block.gpu!.blocks).toBe(1)
    expect(block.gpu!.meanSmActive).toBeCloseTo(40)
    expect(block.gpu!.meanWatts).toBeCloseTo(210)
    expect(block.gpu!.powerLimit).toBeCloseTo(600)
    expect(block.gpu!.peakFbUsed).toBeCloseTo(30)
    expect(block.gpu!.fbTotal).toBeCloseTo(32)
    expect(block.gpu!.minTempMargin).toBeCloseTo(10)
    // A quarter of a second throttled out of two GPU seconds.
    expect(block.gpu!.throttledShare).toBeCloseTo(12.5)
    expect(block.gpu!.pcieReplays).toBe(2)
    expect(block.node!.meanCpuBusy).toBeCloseTo(1600)
    expect(block.node!.peakRamUsed).toBeCloseTo(40)
    expect(block.node!.ramTotal).toBeCloseTo(128)
    expect(block.hasPower && block.hasPcieRate && block.hasDuration).toBe(true)
  })

  it('pools every block of a test file that holds two', () => {
    const twoBlocks: DeviceMetrics = { ...deviceMetrics, tests: { 'c.json': { '0xaa': [busyGpu, idleGpu], '0xbb': [slowGpu] } } }
    const block = reduceBlockMetrics(twoBlocks, null, 'c.json')

    expect(block.gpu!.blocks).toBe(2)
    // The long block weighs three times the short one, so 40 percent for a
    // second beside 20 percent for three reads 25.
    expect(block.gpu!.meanSmActive).toBeCloseTo(25)
    expect(block.gpu!.meanWatts).toBeCloseTo(127.5)
    expect(block.gpu!.peakFbUsed).toBeCloseTo(30)
    expect(block.gpu!.minTempMargin).toBeCloseTo(10)
    // A quarter of a second throttled out of five GPU seconds.
    expect(block.gpu!.throttledShare).toBeCloseTo(5)
    expect(block.gpu!.pcieReplays).toBe(6)
  })

  it('leaves the cards unmeasured when an artifact lacks the block', () => {
    const block = reduceBlockMetrics(deviceMetrics, nodeMetrics, 'a.json')

    expect(block.gpu!.blocks).toBe(1)
    expect(block.node).toBeNull()
  })

  it('leaves the cards unmeasured when the run collected no metrics', () => {
    const block = reduceBlockMetrics(null, undefined, 'b.json')

    expect(block.gpu).toBeNull()
    expect(block.node).toBeNull()
    expect(block.hasPower).toBe(false)
  })
})

describe('deviceColors', () => {
  it('gives every node one hue and every GPU of it one shade', () => {
    const colors = deviceColors([gpuDevice('node2', '1'), gpuDevice('node1', '2'), gpuDevice('node1', '0'), gpuDevice('node1', '1')])

    expect(colors).toEqual(['hsl(25, 70%, 50%)', 'hsl(217, 70%, 70%)', 'hsl(217, 70%, 35%)', 'hsl(217, 70%, 53%)'])
  })
})

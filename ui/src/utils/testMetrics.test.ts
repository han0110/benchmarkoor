import { describe, it, expect } from 'vitest'
import type { TestRemoteMetricsExporter } from '@/api/types'
import { GAUGE_SCALE } from './remoteMetrics'
import { NODE_TRACE_COLUMN, TRACE_COLUMN, deviceColors, reduceGpuTraces, reduceNodeTraces } from './testMetrics'

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
    const torn = row(gpuColumns, { at_ms: 1500, [TRACE_COLUMN.smActive]: 25 * GAUGE_SCALE })
    const traces = reduceGpuTraces({ ...gpuExporter, samples: [[torn], [idle]] })

    expect(traces.smActive![1].data).toEqual([[1.5, 100]])
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

  it('reads processor busy time as a percent and used memory as total less available', () => {
    const traces = reduceNodeTraces(nodeExporter)

    expect(traces.cpuBusy![0].name).toBe('node1')
    expect(traces.cpuBusy![0].data).toEqual([[0.4, null], [1.4, 75]])
    expect(traces.ramUsedGiB![0].data).toEqual([[0.4, 32], [1.4, 40]])
    expect(traces.summary).toEqual({ devices: 1, meanRefreshes: 2, windowSeconds: 1.4 })
  })

  it('leaves out used memory when the file lacks the total', () => {
    const withoutTotal: TestRemoteMetricsExporter = {
      ...nodeExporter,
      columns: nodeColumns.slice(0, 3),
      samples: nodeExporter.samples.map((rows) => rows.map((r) => r.slice(0, 3))),
    }

    expect(reduceNodeTraces(withoutTotal).ramUsedGiB).toBeUndefined()
    expect(reduceNodeTraces(withoutTotal).cpuBusy![0].data).toEqual([[0.4, null], [1.4, 75]])
  })
})

describe('deviceColors', () => {
  it('gives every node one hue and every GPU of it one shade', () => {
    const colors = deviceColors([gpuDevice('node2', '1'), gpuDevice('node1', '2'), gpuDevice('node1', '0'), gpuDevice('node1', '1')])

    expect(colors).toEqual(['hsl(25, 70%, 50%)', 'hsl(217, 70%, 70%)', 'hsl(217, 70%, 35%)', 'hsl(217, 70%, 53%)'])
  })
})

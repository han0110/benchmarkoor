import { describe, it, expect } from 'vitest'
import type { PipelineKind, PipelinePhase, TestPipeline } from '@/api/types'
import { breakdownRows, decodePipeline, itemTitle, kindShade, packRows, UNNAMED_PHASE_COLOR } from './pipeline'

// One proof over two workers on two nodes. Worker 0 meters segment 7, waits in
// the queue, then fast forwards and proves it. Worker 1 fast forwards and proves
// segment 8, then folds both under an internal proof its wrap follows. The last
// row names a kind the kinds list lacks.
const pipeline: TestPipeline = {
  schemaVersion: 1,
  kinds: [
    { name: 'execution', label: 'Metered Execution', legend: 'Metered Execution', row: 'Segment', phase: 'execution' },
    { name: 'fastfwd', label: 'Fast Forward', legend: 'Fast Forward', row: 'Segment', phase: 'execution' },
    { name: 'segment', label: 'Segment', legend: 'Segment', row: 'Segment', phase: 'base' },
    { name: 'leaf', label: 'Leaf Aggregation', legend: 'Leaf Aggregation', row: 'Leaf Aggregation', phase: 'recursion' },
    { name: 'internal', label: 'Internal Aggregation', legend: 'Internal Aggregation', row: 'Internal Aggregation', phase: 'recursion' },
    { name: 'wrap', label: 'Wrap', legend: 'Wrap', row: 'Internal Aggregation', phase: 'wrap' },
  ],
  breakdown: ['Execute Preflight', 'Trace Gen'],
  workers: [
    { name: 'worker_0', node: 'node2' },
    { name: 'worker_5', node: 'node1' },
  ],
  tasks: [
    [0, 0, '#7', 0, 150, []],
    [1, 0, '#7', 200, 300, []],
    [2, 0, '#7', 500, 1000, [[0, 300], [1, 400]]],
    [1, 1, '#8', 300, 200, []],
    [2, 1, '#8', 500, 500, [[0, 250], [1, 260]]],
    [4, 1, 'L1 0-63', 2000, 400, []],
    [5, 1, 'L1 0-63', 2400, 100, []],
    [7, 0, '#9', 100, 100, []],
  ],
}

const model = decodePipeline(pipeline)
const item = (title: string) => model.items.find((candidate) => itemTitle(candidate) === title)!

describe('decodePipeline', () => {
  it('drops a task whose kind the kinds list does not name', () => {
    expect(model.items).toHaveLength(7)
  })

  it('reports the workers in wire order, the kinds it drew in phase order, and the end of the proof', () => {
    expect(model.workers).toEqual(['worker_0', 'worker_5'])
    expect(model.kindsUsed.map((kind) => kind.label)).toEqual(['Metered Execution', 'Fast Forward', 'Segment', 'Internal Aggregation', 'Wrap'])
    expect(model.endSec).toBe(2.5)
  })

  it('paints a kind whose phase the legend has no hue for in the neutral shade, a prototype member included', () => {
    for (const phase of ['contribution' as PipelinePhase, 'constructor' as PipelinePhase]) {
      const unstyled = decodePipeline({
        ...pipeline,
        kinds: [{ name: 'commit', label: 'Contribution', legend: 'Contribution', row: 'Contribution', phase }],
        tasks: [[0, 0, 'Main #137', 0, 200, []]],
      })

      expect(unstyled.items.map((item) => item.color)).toEqual([UNNAMED_PHASE_COLOR])
      expect(unstyled.kindsUsed).toEqual([{ label: 'Contribution', color: UNNAMED_PHASE_COLOR }])
    }
  })

  it('shades every kind of one phase apart and leaves the first kind the phase color', () => {
    expect(model.kindsUsed.map((kind) => kind.color)).toEqual([
      kindShade('execution', 0),
      kindShade('execution', 1),
      kindShade('base', 0),
      kindShade('recursion', 1),
      kindShade('wrap', 0),
    ])
    expect(item('Segment - #7').color).toBe('hsl(161, 35%, 48%)')
  })

  it('draws the kinds of one legend entry in one shade under one entry', () => {
    const grouped = decodePipeline({
      ...instances,
      kinds: [
        { name: 'witness', label: 'Witness Generation', legend: 'Witness Generation', row: 'Contribution', phase: 'witness' },
        { name: 'recompute', label: 'Witness Recompute', legend: 'Witness Generation', row: 'Proof', phase: 'witness' },
        { name: 'basic', label: 'Basic Proof', legend: 'Basic Proof', row: 'Proof', phase: 'base' },
      ],
    })

    expect(grouped.items.map((item) => item.color)).toEqual([kindShade('witness', 0), kindShade('witness', 0), kindShade('base', 0)])
    expect(grouped.kindsUsed.map((kind) => kind.label)).toEqual(['Witness Generation', 'Basic Proof'])
  })

  it('names the legend entry and the row group of a kind that carries neither by its label', () => {
    const early = decodePipeline({
      ...instances,
      kinds: instances.kinds.map(({ name, label, phase }) => ({ name, label, phase })) as PipelineKind[],
    })

    expect(early.kindsUsed.map((kind) => kind.label)).toEqual(['Basic Proof', 'Contribution', 'Compressor', 'Recursive2'])
    expect(packRows(early.items).map((row) => row.title)).toEqual([
      'Contribution - Main #137',
      'Basic Proof - Main #137',
      'Compressor - Main #137',
      'Recursive2 - #2',
    ])
  })
})

describe('kindShade', () => {
  it('darkens the phase color step by step, then raises the saturation', () => {
    expect([0, 1, 2, 3, 4].map((index) => kindShade('base', index))).toEqual([
      'hsl(161, 35%, 48%)',
      'hsl(161, 35%, 38%)',
      'hsl(161, 35%, 28%)',
      'hsl(161, 35%, 18%)',
      'hsl(161, 65%, 48%)',
    ])
  })

  it('holds the seven kinds of the execution phase apart below the saturation ceiling', () => {
    expect([0, 1, 2, 3, 4, 5, 6].map((index) => kindShade('execution', index))).toEqual([
      'hsl(23, 67%, 55%)',
      'hsl(23, 67%, 45%)',
      'hsl(23, 67%, 35%)',
      'hsl(23, 67%, 25%)',
      'hsl(23, 97%, 55%)',
      'hsl(23, 97%, 45%)',
      'hsl(23, 97%, 35%)',
    ])
  })
})

// One ZisK instance committed, proved, then compressed on one worker, beside a
// fold that carries an id of its own. The commit draws on a row of its own.
const instances: TestPipeline = {
  schemaVersion: 1,
  kinds: [
    { name: 'basic', label: 'Basic Proof', legend: 'Basic Proof', row: 'Proof', phase: 'base' },
    { name: 'compressor', label: 'Compressor', legend: 'Compressor', row: 'Proof', phase: 'recursion' },
    { name: 'recursive2', label: 'Recursive2', legend: 'Recursive2', row: 'Fold', phase: 'recursion' },
    { name: 'commit', label: 'Contribution', legend: 'Contribution', row: 'Contribution', phase: 'base' },
  ],
  breakdown: [],
  workers: [{ name: 'worker_0', node: 'node1' }],
  tasks: [
    [3, 0, 'Main #137', 0, 50, []],
    [0, 0, 'Main #137', 100, 200, []],
    [1, 0, 'Main #137', 300, 100, []],
    [2, 0, '#2', 400, 150, []],
  ],
}

describe('packRows', () => {
  it('joins every task of one row group and id on one worker onto one row, titled by both', () => {
    const rows = packRows(model.items)

    expect(rows.map((row) => row.items.map(itemTitle))).toEqual([
      ['Metered Execution - #7', 'Fast Forward - #7', 'Segment - #7'],
      ['Fast Forward - #8', 'Segment - #8'],
      ['Internal Aggregation - L1 0-63', 'Wrap - L1 0-63'],
    ])
    expect(rows.map((row) => row.title)).toEqual(['Segment - #7', 'Segment - #8', 'Internal Aggregation - L1 0-63'])
  })

  it('splits the tasks of one id over its row groups and leaves a task of another id its own row', () => {
    const rows = packRows(decodePipeline(instances).items)

    expect(rows.map((row) => row.items.map(itemTitle))).toEqual([
      ['Contribution - Main #137'],
      ['Basic Proof - Main #137', 'Compressor - Main #137'],
      ['Recursive2 - #2'],
    ])
    expect(rows.map((row) => row.title)).toEqual(['Contribution - Main #137', 'Proof - Main #137', 'Fold - #2'])
  })
})

describe('breakdownRows', () => {
  it('adds an Unattributed row when the sub steps fall short of the bar', () => {
    const rows = breakdownRows(item('Segment - #7'), pipeline.breakdown)

    expect(rows.map((row) => row.label)).toEqual(['Execute Preflight', 'Trace Gen', 'Unattributed', 'Total'])
    expect(rows[2].seconds).toBeCloseTo(0.3)
    expect(rows[2].share).toBeCloseTo(0.3)
    expect(rows[3].seconds).toBeCloseTo(1)
  })

  it('leaves the Unattributed row out when the remainder falls under one percent of the bar', () => {
    const rows = breakdownRows({ ...item('Segment - #7'), breakdown: [[0, 300], [1, 695]] }, pipeline.breakdown)

    expect(rows.map((row) => row.label)).toEqual(['Execute Preflight', 'Trace Gen', 'Total'])
  })

  it('holds the Total row at the bar when the sub steps overrun it', () => {
    const rows = breakdownRows(item('Segment - #8'), pipeline.breakdown)

    expect(rows.map((row) => row.label)).toEqual(['Execute Preflight', 'Trace Gen', 'Total'])
    expect(rows[2].seconds).toBeCloseTo(0.5)
  })

  it('names every section of the kind at zero when this task lacks it', () => {
    const rows = breakdownRows({ ...item('Segment - #8'), breakdown: [[1, 500]] }, pipeline.breakdown)

    expect(rows.map((row) => [row.label, row.seconds])).toEqual([
      ['Execute Preflight', 0],
      ['Trace Gen', 0.5],
      ['Total', 0.5],
    ])
  })

  it('gives a task of a kind with no sub steps an empty table', () => {
    expect(breakdownRows(item('Wrap - L1 0-63'), pipeline.breakdown)).toEqual([])
  })
})

// One ZisK 1.4 proof whose spans nest, with the time no span covers as
// Unattributed segments, and one row whose segments do not match the shape.
const spans: TestPipeline = {
  ...instances,
  breakdown: ['Network Transport', 'Unattributed', 'GEN_PROOF', 'STARK_COMMIT_STAGE_1', 'NTT'],
  tasks: [
    [
      0,
      0,
      'Main #137',
      1000,
      10,
      [],
      [
        [3, 1001000, 3000, 1],
        [2, 1000500, 7500, 0],
        [4, 1001200, 150, 2],
        [4, 1003000, 50, 2],
        [1, 1000000, 500, 0],
        [1, 1008000, 2000, 0],
      ],
    ],
    [1, 0, 'Main #137', 1010, 2, [], [[1, 1010000]]] as unknown as TestPipeline['tasks'][number],
  ],
}

describe('segments', () => {
  const [segmented, ...rest] = decodePipeline(spans).items

  it('drops a row whose segments do not match the shape and flattens the segments to the deepest span over each piece', () => {
    expect(rest).toEqual([])
    expect(segmented.segments.map((segment) => segment.index)).toEqual([1, 2, 3, 4, 3, 4, 3, 2, 1])
    expect(segmented.segments[1].startSec).toBeCloseTo(1.0005)
    expect(segmented.segments[1].endSec).toBeCloseTo(1.001)
    expect(segmented.segments[7].startSec).toBeCloseTo(1.004)
    expect(segmented.segments[7].endSec).toBeCloseTo(1.008)
  })

  it('sums the self time per label, longest first, Unattributed last, and closes on the bar', () => {
    const rows = breakdownRows(segmented, spans.breakdown)

    expect(rows.map((row) => row.label)).toEqual(['GEN_PROOF', 'STARK_COMMIT_STAGE_1', 'NTT', 'Unattributed', 'Total'])
    expect(rows.map((row) => row.seconds)).toEqual([0.0045, 0.0028, 0.0002, 0.0025, 0.01].map((seconds) => expect.closeTo(seconds)))
    expect(rows.slice(0, -1).reduce((sum, row) => sum + row.seconds, 0)).toBeCloseTo(rows[rows.length - 1].seconds)
  })
})

// Two labels under one percent of the bar sum into one Other line, a single one
// keeps its name, and a span past the bar clips to it. A row of a negative
// duration, a label past the table, or a segment of a negative duration drops.
const minor: TestPipeline = {
  ...instances,
  breakdown: ['Unattributed', 'A', 'B', 'C', 'D'],
  tasks: [
    [0, 0, 'Main #1', 0, 1000, [], [[1, 0, 900000, 0], [4, 900000, 1100000, 0], [2, 980000, 5000, 0], [3, 985000, 5000, 0], [0, 990000, 10000, 0]]],
    [0, 0, 'Main #2', 2000, 1000, [], [[1, 2000000, 995000, 0], [2, 2995000, 5000, 0]]],
    [0, 0, 'Main #3', 0, -5, []],
    [0, 0, 'Main #4', 0, 5, [[9, 1]]],
    [0, 0, 'Main #5', 0, 5, [], [[1, 0, -1, 0]]],
  ],
}

describe('minor segments', () => {
  const items = decodePipeline(minor).items

  it('drops the rows that do not match the shape', () => {
    expect(items.map((item) => item.id)).toEqual(['Main #1', 'Main #2'])
  })

  it('sums two labels under the floor into Other before Unattributed and clips a span to its bar', () => {
    const rows = breakdownRows(items[0], minor.breakdown)

    expect(rows.map((row) => row.label)).toEqual(['A', 'D', 'Other (2)', 'Unattributed', 'Total'])
    expect(rows.map((row) => row.seconds)).toEqual([0.9, expect.closeTo(0.08), expect.closeTo(0.01), expect.closeTo(0.01), 1])
  })

  it('keeps the name of a single label under the floor', () => {
    expect(breakdownRows(items[1], minor.breakdown).map((row) => row.label)).toEqual(['A', 'B', 'Total'])
  })
})

import { describe, it, expect } from 'vitest'
import type { RunEstimate, SuiteTest } from '@/api/types'
import {
  appliedSort,
  comparedFigures,
  comparedTests,
  estimateCoverage,
  groupComparison,
  groupDimensions,
  kindRatios,
  ratioSummary,
  sharedTests,
  sortComparedTests,
  sortGroups,
  type ComparedSortField,
} from './estimateComparison'

const name = (fn: string, tier: string, tokens = '') =>
  `benchmark/compute/instruction/test_arithmetic.py::test_${fn}[fork_Amsterdam-blockchain_test-${tokens}benchmark-gas-value_${tier}]`

const estimate = (tests: RunEstimate['tests'], failures?: Record<string, string>): RunEstimate => ({
  timestamp: 1790390784,
  suite_hash: 'f585281e3fea89a8',
  instance: { id: 'reth-zisk', client: 'provoor' },
  metadata: { labels: { zkvm: 'zisk', zkvm_version: 'v1.3.0-alpha' } },
  zkvm: 'zisk',
  image: 'ghcr.io/eth-act/ere/ere-server-zisk:77e2aae',
  elf_url: 'https://example.invalid/guest.elf',
  elf_sha256: '00',
  tests,
  failures,
})

const estimated = (main: number, memory = 0, peakHeapBytes?: number) => ({
  cost: { main, memory },
  peak_heap_bytes: peakHeapBytes,
})

describe('ratioSummary', () => {
  it('parts the geomean from the sum ratio where a cheap test grows and an expensive one shrinks', () => {
    const baseline = estimate({ a: estimated(1), b: estimated(100) })
    const other = estimate({ a: estimated(4), b: estimated(50) })

    const summary = ratioSummary(other, baseline, ['a', 'b'], 'cost')!
    expect(summary.geomean).toBeCloseTo(Math.SQRT2, 12)
    expect(summary.sumRatio).toBeCloseTo(54 / 101, 12)
    expect(summary.p5).toBeCloseTo(0.675, 12)
    expect(summary.p50).toBeCloseTo(2.25, 12)
    expect(summary.p95).toBeCloseTo(3.825, 12)
    expect([summary.cheaper, summary.within, summary.dearer]).toEqual([1, 0, 1])
  })

  it('counts the band edges as within and leaves a test without a positive cost on both sides out of the ratios', () => {
    const baseline = estimate({ a: estimated(100), b: estimated(100), c: estimated(100), d: estimated(100) })
    const other = estimate({ a: estimated(98), b: estimated(102), c: estimated(97), d: estimated(0) })

    const summary = ratioSummary(other, baseline, ['a', 'b', 'c', 'd'], 'cost')!
    expect([summary.cheaper, summary.within, summary.dearer]).toEqual([1, 2, 0])
    expect(summary.sumRatio).toBeCloseTo(297 / 400, 12)
  })

  it('states no summary where no test has a positive cost on both sides', () => {
    expect(ratioSummary(estimate({ a: estimated(0) }), estimate({ a: estimated(5) }), ['a'], 'cost')).toBeNull()
  })

  it('reads the peak heap in place of the cost', () => {
    const baseline = estimate({ a: estimated(1, 0, 100), b: estimated(1, 0, 400) })
    const other = estimate({ a: estimated(9, 0, 200), b: estimated(9, 0, 200) })

    const summary = ratioSummary(other, baseline, ['a', 'b'], 'heap')!
    expect(summary.geomean).toBeCloseTo(1, 12)
    expect(summary.sumRatio).toBeCloseTo(400 / 500, 12)
    expect([summary.cheaper, summary.within, summary.dearer]).toEqual([1, 0, 1])
  })
})

describe('sharedTests', () => {
  const baseline = estimate({ a: estimated(1, 0, 100), b: estimated(1, 0, 200), c: estimated(1, 0, 300) })
  const other = estimate({ a: estimated(2, 0, 100), b: estimated(2), d: estimated(1, 0, 5) })

  it('keeps the tests estimated in every estimate that the filter keeps', () => {
    expect(sharedTests([baseline, other], () => true, 'cost')).toEqual(['a', 'b'])
    expect(sharedTests([baseline, other], (testName) => testName !== 'a', 'cost')).toEqual(['b'])
  })

  it('leaves a test without a peak heap on one side out of the heap comparison', () => {
    expect(sharedTests([baseline, other], () => true, 'heap')).toEqual(['a'])
  })
})

describe('kindRatios', () => {
  const baseline = estimate({ a: estimated(10, 2), b: estimated(30, 6) })
  const other = estimate({ a: estimated(20, 1), b: estimated(10, 3) })
  const table = kindRatios([baseline, other], ['a', 'b'], ['main', 'memory', 'opcode'], 0)

  it('takes the mean of each kind over the shared tests and its ratio to the baseline', () => {
    expect(table.kinds[0]).toEqual({ means: [20, 15], ratios: [1, 0.75] })
    expect(table.kinds[1]).toEqual({ means: [4, 2], ratios: [1, 0.5] })
  })

  it('states no ratio for a kind the baseline has no cost for', () => {
    expect(table.kinds[2]).toEqual({ means: [0, 0], ratios: [null, null] })
  })

  it('gives the total the sum ratio', () => {
    expect(table.total.means).toEqual([24, 17])
    expect(table.total.ratios[1]).toBeCloseTo(ratioSummary(other, baseline, ['a', 'b'], 'cost')!.sumRatio, 12)
  })
})

describe('estimateCoverage', () => {
  it('counts the tests the filter keeps and the cost share of the passed tests outside the shared set', () => {
    const covered = estimate({ a: estimated(30), b: estimated(10), c: estimated(60) }, { d: 'guest panicked', e: 'guest panicked' })
    const keep = (testName: string) => testName !== 'c' && testName !== 'e'

    expect(estimateCoverage(covered, new Set(['a']), keep)).toEqual({ passed: 2, failed: 1, outside: 1, outsideShare: 0.25 })
  })

  it('states no share where no test passed', () => {
    expect(estimateCoverage(estimate({}, { a: 'guest panicked' }), new Set(), () => true)).toEqual({
      passed: 0,
      failed: 1,
      outside: 0,
      outsideShare: null,
    })
  })
})

describe('comparedTests', () => {
  const suiteTests = [{ name: 'b' }, { name: 'a' }, { name: 'c' }, { name: 'd' }] as SuiteTest[]
  const baseline = estimate({ a: estimated(10, 0, 100), b: estimated(20, 0, 200), c: estimated(5) }, { d: 'guest panicked' })
  const other = estimate({ a: estimated(15, 0, 50), b: estimated(10, 0, 400), y: estimated(1), z: estimated(1) }, { c: 'out of memory' })

  it('lists the passed and failed tests the filter keeps in suite order, the tests the suite does not list going last in turn', () => {
    const rows = comparedTests([baseline, other], suiteTests, (testName) => testName !== 'd', 'cost')

    expect(rows.map((row) => [row.testName, row.testNumber, row.shared])).toEqual([
      ['b', 1, true],
      ['a', 2, true],
      ['c', 3, false],
      ['y', 5, false],
      ['z', 6, false],
    ])
    expect(rows[2].values).toEqual([5, null])
    expect(rows[2].errors).toEqual([undefined, 'out of memory'])
  })

  it('reads the peak heap in place of the cost', () => {
    const rows = comparedTests([baseline, other], suiteTests, () => true, 'heap')
    expect(rows.map((row) => row.values)).toEqual([[200, 400], [100, 50], [null, null], [null, null], [null, null], [null, null]])
  })

  it('marks a test shared only where every estimate has the value, as the shared tests do', () => {
    const estimates = [estimate({ a: estimated(1, 0, 100) }), estimate({ a: estimated(1, 0, 200) }), estimate({ a: estimated(1) })]
    const [row] = comparedTests(estimates, undefined, () => true, 'heap')

    expect(sharedTests(estimates, () => true, 'heap')).toEqual([])
    expect(row.shared).toBe(false)
    expect(comparedFigures(row, 1, 0).ratio).toBeNull()
  })
})

describe('sortComparedTests', () => {
  const baseline = estimate({ a: estimated(10), b: estimated(20), c: estimated(40), d: estimated(8) })
  const other = estimate({ a: estimated(15), b: estimated(10), c: estimated(50) }, { d: 'guest panicked' })
  const rows = comparedTests([baseline, other], undefined, () => true, 'cost')
  const order = (sortBy: ComparedSortField, sortDir: 'asc' | 'desc') =>
    sortComparedTests(rows, sortBy, sortDir, 0).map((row) => row.testName)

  it('sorts by the ratio to the baseline, a test outside the shared set going last both ways', () => {
    expect(order('ratio:1', 'desc')).toEqual(['a', 'c', 'b', 'd'])
    expect(order('ratio:1', 'asc')).toEqual(['b', 'c', 'a', 'd'])
  })

  it('sorts by the signed delta to the baseline, a test outside the shared set going last both ways', () => {
    expect(order('delta:1', 'desc')).toEqual(['c', 'a', 'b', 'd'])
    expect(order('delta:1', 'asc')).toEqual(['b', 'a', 'c', 'd'])
  })
})

describe('appliedSort', () => {
  it('sorts by the ratio of the first estimate that is not the baseline where no sort is set or the baseline removed the sorted column', () => {
    expect(appliedSort(null, 0)).toEqual({ sortBy: 'ratio:1', sortDir: 'desc' })
    expect(appliedSort({ sortBy: 'delta:1', sortDir: 'asc' }, 1)).toEqual({ sortBy: 'ratio:0', sortDir: 'desc' })
    expect(appliedSort({ sortBy: 'value:1', sortDir: 'asc' }, 1)).toEqual({ sortBy: 'value:1', sortDir: 'asc' })
  })
})

describe('groupComparison', () => {
  it('groups the shared tests and takes the ratio of the group sums rather than the mean of the test ratios', () => {
    const baseline = estimate({ [name('add', '10M')]: estimated(1), [name('mul', '10M')]: estimated(100), [name('add', '60M')]: estimated(10) })
    const other = estimate({ [name('add', '10M')]: estimated(4), [name('mul', '10M')]: estimated(50), [name('add', '60M')]: estimated(30) })

    const groups = groupComparison([baseline, other], Object.keys(baseline.tests), 'gas', 0, 'cost')
    expect(sortGroups(groups, 'ratio:1', 'desc')).toEqual([
      { group: '60M', tests: 1, means: [10, 30], ratios: [1, 3] },
      { group: '10M', tests: 2, means: [50.5, 27], ratios: [1, 54 / 101] },
    ])
  })

  it('groups by a parameter or a label, a test with two labels counting in both, and reads the peak heap', () => {
    const warm = name('add', '10M', 'opcode_ADD-size_32-warm-')
    const cold = name('add', '60M', 'opcode_ADD-size_64-cold-')
    const warmHot = name('mul', '10M', 'opcode_MUL-size_32-warm-hot-')
    const baseline = estimate({ [warm]: estimated(1, 0, 100), [cold]: estimated(1, 0, 300), [warmHot]: estimated(1, 0, 200) })
    const other = estimate({ [warm]: estimated(1, 0, 300), [cold]: estimated(1, 0, 150), [warmHot]: estimated(1, 0, 100) })
    const names = [warm, cold, warmHot]

    expect(groupComparison([baseline, other], names, 'label', 0, 'heap')).toEqual([
      { group: 'warm', tests: 2, means: [150, 200], ratios: [1, 400 / 300] },
      { group: 'cold', tests: 1, means: [300, 150], ratios: [1, 0.5] },
      { group: 'hot', tests: 1, means: [200, 100], ratios: [1, 0.5] },
    ])
    expect(groupComparison([baseline, other], names, 'size', 1, 'heap')).toEqual([
      { group: '32', tests: 2, means: [150, 200], ratios: [300 / 400, 1] },
      { group: '64', tests: 1, means: [300, 150], ratios: [2, 1] },
    ])
  })
})

describe('groupDimensions', () => {
  it('lists the dimensions with two values or more, the parameters in name order and the label last', () => {
    const names = [
      name('add', '10M', 'opcode_ADD-size_32-mem_size_0-k_1-warm-'),
      name('add', '60M', 'opcode_ADD-size_64-mem_size_0-k_1-cold-'),
      name('mul', '10M', 'opcode_MUL-size_32-mem_size_1-k_1-warm-hot-'),
    ]

    expect(groupDimensions(names, '')).toEqual([
      { key: 'fn', label: 'Test', groups: 2 },
      { key: 'gas', label: 'Gas', groups: 2 },
      { key: 'opcode', label: 'Opcode', groups: 2 },
      { key: 'mem_size', label: 'mem_size', groups: 2 },
      { key: 'size', label: 'size', groups: 2 },
      { key: 'label', label: 'Label', groups: 3 },
    ])
  })

  it('keeps a dimension with one group while the query holds a term with its key', () => {
    const names = [name('add', '10M', 'SSTORE_same-'), name('mul', '10M', 'SSTORE_same-')]

    expect(groupDimensions(names, 'file=arithmetic sstore:same fork')).toEqual([
      { key: 'file', label: 'File', groups: 1 },
      { key: 'fn', label: 'Test', groups: 2 },
      { key: 'SSTORE', label: 'SSTORE', groups: 1 },
    ])
  })

  it('keeps a dimension with one group while the query holds a term with an alias of its key', () => {
    const names = [name('add', '60M', 'opcode_ADD-'), name('add', '60M', 'opcode_MUL-')]

    expect(groupDimensions(names, 'function=add benchmark=60M')).toEqual([
      { key: 'fn', label: 'Test', groups: 1 },
      { key: 'gas', label: 'Gas', groups: 1 },
      { key: 'opcode', label: 'Opcode', groups: 2 },
    ])
  })
})

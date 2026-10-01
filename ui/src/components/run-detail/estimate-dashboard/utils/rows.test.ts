import { describe, it, expect } from 'vitest'
import type { BlockLogEntry, RunEstimate } from '@/api/types'
import type { EstimateDimension, EstimateState } from '../types'
import { estimateData, sortDimensionRows, sortRows, summariseByDimension } from './rows'

const estimate: RunEstimate = {
  timestamp: 1790390784,
  suite_hash: 'f585281e3fea89a8',
  instance: { id: 'reth-openvm', client: 'provoor' },
  metadata: { labels: { zkvm: 'openvm', zkvm_version: 'v2.1.0-preview' } },
  zkvm: 'openvm',
  image: 'ghcr.io/eth-act/ere/ere-server-openvm:0.18.0',
  elf_url: 'https://example.invalid/guest.elf',
  elf_sha256: '00',
  tests: {
    'benchmark/compute/instruction/test_memory.py::slow': { cost: { rv64: 3, precompile: 0 } },
    'benchmark/compute/instruction/test_memory.py::quick': { cost: { rv64: 1, precompile: 0 } },
    'benchmark/compute/precompile/test_bls12_381.py::middling': { cost: { rv64: 1, precompile: 1 } },
    'benchmark/compute/scenario/test_x.py::untimed': { cost: { rv64: 4, precompile: 0 } },
    'benchmark/compute/scenario/test_x.py::zeroed': { cost: { rv64: 0, precompile: 0 } },
  },
  failures: { 'benchmark/compute/scenario/test_x.py::broken': 'guest panicked' },
}

const blockLog = (totalMs: number, throughput: number): BlockLogEntry => ({
  block: { number: 1, hash: '0x1', gas_used: 0, tx_count: 0 },
  timing: { execution_ms: totalMs / 2, state_read_ms: 0, state_hash_ms: 0, commit_ms: 0, total_ms: totalMs },
  throughput: { mgas_per_sec: throughput },
})

const blockLogs = {
  'benchmark/compute/instruction/test_memory.py::slow': blockLog(7, 10),
  'benchmark/compute/instruction/test_memory.py::quick': blockLog(3, 30),
  'benchmark/compute/precompile/test_bls12_381.py::middling': blockLog(5, 20),
  'benchmark/compute/scenario/test_x.py::zeroed': blockLog(0, 0),
}

const state: EstimateState = {
  activeTab: 'overview',
  categories: [],
  sortBy: 'order',
  sortOrder: 'asc',
  costShare: false,
  signedError: false,
  fitModel: 'least-squares',
}

const kinds = ['rv64', 'precompile']
const short = (name: string) => name.slice(name.indexOf('::') + 2)

describe('estimateData', () => {
  it('reads every estimated test the page keeps and fits the timed ones', () => {
    const data = estimateData({ estimate, blockLogs, isProving: true, kinds, state })

    expect(data.rows.map((row) => short(row.testName))).toEqual(['quick', 'slow', 'middling', 'untimed', 'zeroed'])
    expect(data.rows.map((row) => row.category)).toEqual(['memory', 'memory', 'bls', 'scenario', 'scenario'])
    expect(data.rows.map((row) => row.testIndex)).toEqual([1, 2, 3, 4, 5])
    expect(data.fit!.slope).toBeCloseTo(2, 10)
    expect(data.rows[1]).toMatchObject({ total: 3, timeMs: 7, throughput: 10 })
    expect(data.rows[1].fittedMs).toBeCloseTo(7, 10)
    expect(data.rows[1].error).toBeCloseTo(0, 10)
    expect(data.rows[3]).toMatchObject({ timeMs: null, error: null, throughput: null })
    expect(data.rows[3].fittedMs).toBeCloseTo(9, 10)
    expect(data.rows[4]).toMatchObject({ timeMs: null, error: null })
    expect(data.breakdown).toMatchObject({ memory: 2, bls: 1, scenario: 2, other: 0 })
    expect(data).toMatchObject({ maxThroughput: 30, passed: 5, hasTiming: true })
  })

  it('keeps only the categories and the throughput range the bar selects, and renumbers the rows', () => {
    const data = estimateData({ estimate, blockLogs, isProving: true, kinds, state: { ...state, categories: ['memory'], minThroughput: 20 } })

    expect(data.rows.map((row) => short(row.testName))).toEqual(['quick'])
    expect(data.rows[0].testIndex).toBe(1)
    expect(data.fit!.slope).toBe(0)
    // The breakdown and the slider read every estimated test, so the bar keeps its choices in view.
    expect(data.breakdown.scenario).toBe(2)
    expect(data.maxThroughput).toBe(30)
  })

  it('reads only the tests the page filters keep', () => {
    const data = estimateData({ estimate, blockLogs, isProving: true, kinds, state, searchQuery: 'test_x' })

    expect(data.rows.map((row) => short(row.testName))).toEqual(['untimed', 'zeroed'])
    expect(data).toMatchObject({ fit: null, passed: 2, hasTiming: true })
    expect(data.rows[0].fittedMs).toBeNull()
  })

  it('reads the execution time of a run that executes', () => {
    const data = estimateData({ estimate, blockLogs, isProving: false, kinds, state })

    expect(data.rows[1].timeMs).toBe(3.5)
  })

  it('has no timing without block logs', () => {
    const data = estimateData({ estimate, isProving: true, kinds, state })

    expect(data).toMatchObject({ fit: null, maxThroughput: null, hasTiming: false })
    expect(data.rows.every((row) => row.timeMs === null && row.throughput === null)).toBe(true)
  })

  it('ignores the throughput range where the block logs time no test the search keeps', () => {
    const bounded = { ...state, minThroughput: 20, maxThroughput: 25 }

    expect(estimateData({ estimate, blockLogs, isProving: true, kinds, state: bounded, searchQuery: 'untimed' }).rows.map((row) => short(row.testName))).toEqual(['untimed'])
    expect(estimateData({ estimate, isProving: true, kinds, state: bounded }).rows).toHaveLength(5)
  })
})

describe('sortRows', () => {
  const { rows } = estimateData({ estimate, blockLogs, isProving: true, kinds, state })
  const names = (sorted: { testName: string }[]) => sorted.map((row) => short(row.testName))

  it('sorts on a figure either way, an untimed row going last both ways', () => {
    expect(names(sortRows(rows, kinds, { ...state, sortBy: 'time', sortOrder: 'asc' }))).toEqual(['quick', 'middling', 'slow', 'untimed', 'zeroed'])
    expect(names(sortRows(rows, kinds, { ...state, sortBy: 'time', sortOrder: 'desc' }))).toEqual(['slow', 'middling', 'quick', 'untimed', 'zeroed'])
  })

  it('sorts a kind on its cost', () => {
    expect(names(sortRows(rows, kinds, { ...state, sortBy: 'kind:precompile', sortOrder: 'desc' }))).toEqual(['middling', 'quick', 'slow', 'untimed', 'zeroed'])
  })

  it('sorts the error on its signed value, an untimed row going last both ways', () => {
    const skewed = estimateData({
      estimate,
      blockLogs: { ...blockLogs, 'benchmark/compute/instruction/test_memory.py::quick': blockLog(1, 30) },
      isProving: true,
      kinds,
      state,
    }).rows

    expect(names(sortRows(skewed, kinds, { ...state, sortBy: 'error', sortOrder: 'asc' }))).toEqual(['quick', 'slow', 'middling', 'untimed', 'zeroed'])
    expect(names(sortRows(skewed, kinds, { ...state, sortBy: 'error', sortOrder: 'desc' }))).toEqual(['middling', 'slow', 'quick', 'untimed', 'zeroed'])
  })
})

const tiered = (test: string, gas: string) => `benchmark/compute/${test}[fork_Osaka-blockchain_test-benchmark-gas-value_${gas}]`
const add10 = tiered('instruction/test_arithmetic.py::test_add', '10M')
const add60 = tiered('instruction/test_arithmetic.py::test_add', '60M')
const mulmod10 = tiered('instruction/test_arithmetic.py::test_mulmod', '10M')
const mulmod60 = tiered('instruction/test_arithmetic.py::test_mulmod', '60M')
const exp60 = tiered('instruction/test_arithmetic.py::test_exp', '60M')
const xor60 = tiered('instruction/test_bitwise.py::test_xor', '60M')
const shl60 = tiered('instruction/test_bitwise.py::test_shl', '60M')
const and10 = tiered('instruction/test_bitwise.py::test_and', '10M')
const modexp60 = tiered('precompile/test_modexp.py::test_modexp', '60M')

const tieredEstimate: RunEstimate = {
  ...estimate,
  tests: {
    [add10]: { cost: { main: 1, precompile: 0 }, peak_heap_bytes: 100 },
    [add60]: { cost: { main: 6, precompile: 0 }, peak_heap_bytes: 300 },
    [mulmod10]: { cost: { main: 3, precompile: 1 }, peak_heap_bytes: 200 },
    [mulmod60]: { cost: { main: 18, precompile: 6 } },
    [xor60]: { cost: { main: 12, precompile: 0 }, peak_heap_bytes: 400 },
  },
  failures: { [exp60]: 'guest panicked', [shl60]: 'guest panicked', [modexp60]: 'guest panicked' },
}

const tieredKinds = ['main', 'precompile']
// The suite lists the bitwise file first, so the suite order is not the name order, and it holds and10, which the estimate lacks.
const suiteTests = [xor60, shl60, and10, add10, add60, mulmod10, mulmod60, exp60, modexp60].map((name) => ({ name }))
const testNames = (rows: { testName: string }[]) => rows.map((row) => row.testName)
const read = (overrides: Partial<EstimateState> = {}, searchQuery?: string) =>
  estimateData({ estimate: tieredEstimate, isProving: false, kinds: tieredKinds, suiteTests, searchQuery, state: { ...state, ...overrides } })

describe('estimateData over a suite', () => {
  it('keeps every category of an estimate with no estimated test, which shows no filter bar', () => {
    const noneEstimated: RunEstimate = { ...tieredEstimate, tests: {}, failures: { ...tieredEstimate.failures, [and10]: 'guest panicked' } }
    const data = estimateData({ estimate: noneEstimated, isProving: false, kinds: [], suiteTests, state: { ...state, categories: ['arithmetic'] } })

    expect(data.failures).toEqual([shl60, and10, exp60, modexp60])
  })

  it('keeps the failures of the category and the search', () => {
    expect(read().failures).toEqual([shl60, exp60, modexp60])
    expect(read({ categories: ['arithmetic'] }).failures).toEqual([shl60, exp60])
    expect(read({}, 'file=arithmetic').failures).toEqual([exp60])
  })

  it('keeps only the cost range the bar selects, both bounds included, and every failure', () => {
    const data = read({ minCost: 4, maxCost: 12 })

    expect(testNames(data.rows)).toEqual([xor60, add60, mulmod10])
    // The limits read every estimated test, so the slider keeps its ends.
    expect(data).toMatchObject({ failures: [shl60, exp60, modexp60], minCost: 1, maxCost: 24 })
  })

  it('keeps only the tests the status filter accepts, in the rows, the failures, and the counts', () => {
    // The filter leaves out and10, the one suite test the estimate lacks, so no test is missing.
    const accepted = new Set([xor60, shl60, add10, mulmod60])
    const data = estimateData({
      estimate: tieredEstimate,
      isProving: false,
      kinds: tieredKinds,
      suiteTests,
      includeTest: (testName) => accepted.has(testName),
      state,
    })

    expect(testNames(data.rows)).toEqual([xor60, add10, mulmod60])
    expect(data).toMatchObject({ failures: [shl60], passed: 3, failed: 1, missing: 0 })
  })

  it('counts the passed, failed, and missing tests of the search alone', () => {
    expect(read()).toMatchObject({ passed: 5, failed: 3, missing: 1 })
    expect(read({ categories: ['memory'] }, 'file=bitwise')).toMatchObject({ passed: 1, failed: 1, missing: 1 })
    expect(read({}, 'file=arithmetic')).toMatchObject({ passed: 4, failed: 1, missing: 0 })
  })

  it('sorts the peak heap, a test without one going last both ways', () => {
    const { rows } = read()

    expect(testNames(sortRows(rows, tieredKinds, { ...state, sortBy: 'heap', sortOrder: 'asc' }))).toEqual([add10, mulmod10, add60, xor60, mulmod60])
    expect(testNames(sortRows(rows, tieredKinds, { ...state, sortBy: 'heap', sortOrder: 'desc' }))).toEqual([xor60, add60, mulmod10, add10, mulmod60])
  })
})

describe('summariseByDimension', () => {
  const { rows, failures } = read({}, 'gas=60M')
  const groups = summariseByDimension(rows, failures, 'file', tieredKinds, false, 'cost')
  const group = (value: string) => groups.find((row) => row.value === value)
  const values = (sorted: { value: string }[]) => sorted.map((row) => row.value)

  // add60 runs over its fit and xor60 under it, while mulmod60 is not timed.
  const fitErrors = new Map([[add60, 0.375], [xor60, -0.5]])
  const timed = rows.map((row) => ({ ...row, error: fitErrors.get(row.testName) ?? null }))
  const timedGroups = (dimension: EstimateDimension, signedError: boolean) => summariseByDimension(timed, failures, dimension, tieredKinds, signedError, 'cost')

  it('sums the kept tests of each file and lists a file whose every test failed', () => {
    expect(group('arithmetic')).toMatchObject({ tests: 2, failed: 1, max: 24, mean: 15, share: 30 / 42, kindShares: [0.8, 0.2], kindMeans: [12, 3] })
    expect(group('bitwise')).toMatchObject({ tests: 1, failed: 1, max: 12, mean: 12, share: 12 / 42, kindShares: [1, 0], kindMeans: [12, 0] })
    expect(group('modexp')).toMatchObject({ tests: 0, failed: 1, max: null, mean: null, share: null, kindShares: [null, null], kindMeans: [null, null] })
  })

  it('takes the largest and the mean peak heap of each file from the tests that report one', () => {
    const all = read()
    const heaps = summariseByDimension(all.rows, all.failures, 'file', tieredKinds, false, 'heap')

    // mulmod60 reports no heap, so the arithmetic mean reads add10, add60, and mulmod10 only.
    expect(Object.fromEntries(heaps.map((row) => [row.value, [row.max, row.mean]]))).toEqual({ arithmetic: [300, 200], bitwise: [400, 400], modexp: [null, null] })
    expect(values(sortDimensionRows(heaps, tieredKinds, 'max', 'desc', false))).toEqual(['bitwise', 'arithmetic', 'modexp'])
  })

  it('sorts a group with only failures last both ways', () => {
    expect(values(sortDimensionRows(groups, tieredKinds, 'max', 'desc', true))).toEqual(['arithmetic', 'bitwise', 'modexp'])
    expect(values(sortDimensionRows(groups, tieredKinds, 'max', 'asc', true))).toEqual(['bitwise', 'arithmetic', 'modexp'])
  })

  it('takes the mean fit error of the timed tests of each group, signed or unsigned', () => {
    const errors = (dimension: EstimateDimension, signedError: boolean) => Object.fromEntries(timedGroups(dimension, signedError).map((row) => [row.value, row.error]))

    expect(errors('file', true)).toEqual({ arithmetic: 0.375, bitwise: -0.5, modexp: null })
    expect(errors('file', false)).toEqual({ arithmetic: 0.375, bitwise: 0.5, modexp: null })
    // The mulmod group holds an estimated test but no timed one.
    expect(errors('fn', true)).toMatchObject({ add: 0.375, mulmod: null })
  })

  it('sorts the fit error signed or unsigned, a group with no timed test going last both ways', () => {
    const sorted = (signedError: boolean, sortOrder: EstimateState['sortOrder']) => values(sortDimensionRows(timedGroups('file', signedError), tieredKinds, 'error', sortOrder, true))

    expect(sorted(true, 'asc')).toEqual(['bitwise', 'arithmetic', 'modexp'])
    expect(sorted(false, 'asc')).toEqual(['arithmetic', 'bitwise', 'modexp'])
    expect(sorted(false, 'desc')).toEqual(['bitwise', 'arithmetic', 'modexp'])
  })

  it('counts a test with two labels in both groups and leaves out a test without a label', () => {
    const labelled = (tokens: string) => `benchmark/compute/instruction/test_storage.py::test_sload[fork_Osaka-blockchain_test-${tokens}benchmark-gas-value_10M]`
    const warm = labelled('warm-')
    const warmHot = labelled('warm-hot-')
    const labelledEstimate: RunEstimate = {
      ...tieredEstimate,
      tests: { [warm]: { cost: { main: 1, precompile: 0 } }, [warmHot]: { cost: { main: 3, precompile: 0 } }, [add10]: { cost: { main: 5, precompile: 0 } } },
      failures: { [labelled('cold-')]: 'guest panicked' },
    }
    const data = estimateData({ estimate: labelledEstimate, isProving: false, kinds: tieredKinds, state })
    const labels = summariseByDimension(data.rows, data.failures, 'label', tieredKinds, false, 'cost')

    expect(Object.fromEntries(labels.map((row) => [row.value, [row.tests, row.failed, row.max]]))).toEqual({ warm: [2, 0, 3], hot: [1, 0, 3], cold: [0, 1, null] })
  })
})

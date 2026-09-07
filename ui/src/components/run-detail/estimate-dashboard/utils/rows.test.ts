import { describe, it, expect } from 'vitest'
import type { BlockLogEntry, RunEstimate } from '@/api/types'
import type { EstimateState } from '../types'
import { estimateData, sortRows } from './rows'

const estimate: RunEstimate = {
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
  it('prices every test the page keeps and fits the timed ones', () => {
    const data = estimateData({ estimate, blockLogs, isProving: true, kinds, state })

    expect(data.rows.map((row) => short(row.testName))).toEqual(['quick', 'slow', 'middling', 'untimed', 'zeroed'])
    expect(data.rows.map((row) => row.category)).toEqual(['memory', 'memory', 'bls', 'scenario', 'scenario'])
    expect(data.rows.map((row) => row.testIndex)).toEqual([1, 2, 3, 4, 5])
    expect(data.fit!.slope).toBeCloseTo(2, 10)
    expect(data.rows[1]).toMatchObject({ total: 3, timeMs: 7, throughput: 10, shares: [1, 0] })
    expect(data.rows[1].fittedMs).toBeCloseTo(7, 10)
    expect(data.rows[1].error).toBeCloseTo(0, 10)
    expect(data.rows[3]).toMatchObject({ timeMs: null, error: null, throughput: null })
    expect(data.rows[3].fittedMs).toBeCloseTo(9, 10)
    expect(data.rows[4]).toMatchObject({ timeMs: null, error: null, shares: [null, null] })
    expect(data.breakdown).toMatchObject({ memory: 2, bls: 1, scenario: 2, other: 0 })
    expect(data).toMatchObject({ maxThroughput: 30, priced: 5, hasTiming: true })
  })

  it('keeps only the categories and the throughput range the bar selects, and renumbers the rows', () => {
    const data = estimateData({ estimate, blockLogs, isProving: true, kinds, state: { ...state, categories: ['memory'], minThroughput: 20 } })

    expect(data.rows.map((row) => short(row.testName))).toEqual(['quick'])
    expect(data.rows[0].testIndex).toBe(1)
    expect(data.fit!.slope).toBe(0)
    // The breakdown and the slider read every priced test, so the bar keeps its choices in view.
    expect(data.breakdown.scenario).toBe(2)
    expect(data.maxThroughput).toBe(30)
  })

  it('reads only the tests the page filters keep', () => {
    const data = estimateData({ estimate, blockLogs, isProving: true, kinds, state, searchQuery: 'test_x' })

    expect(data.rows.map((row) => short(row.testName))).toEqual(['untimed', 'zeroed'])
    expect(data).toMatchObject({ fit: null, priced: 2, hasTiming: true })
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
})

describe('sortRows', () => {
  const { rows } = estimateData({ estimate, blockLogs, isProving: true, kinds, state })
  const names = (sorted: { testName: string }[]) => sorted.map((row) => short(row.testName))

  it('sorts on a figure either way, an untimed row going last both ways', () => {
    expect(names(sortRows(rows, kinds, { ...state, sortBy: 'time', sortOrder: 'asc' }))).toEqual(['quick', 'middling', 'slow', 'untimed', 'zeroed'])
    expect(names(sortRows(rows, kinds, { ...state, sortBy: 'time', sortOrder: 'desc' }))).toEqual(['slow', 'middling', 'quick', 'untimed', 'zeroed'])
  })

  it('sorts a kind on its cost or on its share', () => {
    expect(names(sortRows(rows, kinds, { ...state, sortBy: 'kind:precompile', sortOrder: 'desc' }))).toEqual(['middling', 'quick', 'slow', 'untimed', 'zeroed'])
    expect(names(sortRows(rows, kinds, { ...state, sortBy: 'kind:rv64', sortOrder: 'asc', costShare: true }))).toEqual(['middling', 'quick', 'slow', 'untimed', 'zeroed'])
  })

  it('sorts the error signed or unsigned', () => {
    const skewed = estimateData({
      estimate,
      blockLogs: { ...blockLogs, 'benchmark/compute/instruction/test_memory.py::quick': blockLog(1, 30) },
      isProving: true,
      kinds,
      state,
    }).rows
    const signed = sortRows(skewed, kinds, { ...state, sortBy: 'error', sortOrder: 'asc', signedError: true })
    const unsigned = sortRows(skewed, kinds, { ...state, sortBy: 'error', sortOrder: 'asc' })

    expect(signed[0].error).toBeLessThan(0)
    expect(unsigned.slice(0, 3).map((row) => Math.abs(row.error!))).toEqual([...unsigned.slice(0, 3).map((row) => Math.abs(row.error!))].sort((a, b) => a - b))
    expect(names(signed).slice(3)).toEqual(['untimed', 'zeroed'])
  })

  it('sorts the category by name', () => {
    expect(names(sortRows(rows, kinds, { ...state, sortBy: 'category', sortOrder: 'asc' }))).toEqual(['middling', 'quick', 'slow', 'untimed', 'zeroed'])
  })
})

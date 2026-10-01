import { describe, it, expect } from 'vitest'
import type { EstimateIndexEntry, RunEstimate } from '@/api/types'
import { MAX_COMPARE_RUNS, RUN_SLOTS, formatRunLabel } from '@/components/compare/constants'
import { availableLabels, estimateCompareRun, selectionBlocker, sortEstimates, spansEreTags, spansSuites, type EstimateSortColumn } from './estimateEntries'

const entry = (estimateId: string, fields: Partial<EstimateIndexEntry> = {}): EstimateIndexEntry => ({
  estimate_id: estimateId,
  timestamp: 1790390784,
  suite_hash: 's1',
  instance: { id: `${estimateId}-zisk`, client: 'provoor' },
  metadata: { stateless_validator: estimateId, zkvm: 'zisk', zkvm_version: 'v1.3.0-alpha' },
  image: 'ghcr.io/eth-act/ere/ere-server-zisk:77e2aae',
  tests: { tests_passed: 1, tests_failed: 0 },
  cost: { main: 1 },
  ...fields,
})

describe('sortEstimates', () => {
  const entries = [
    entry('reth', {
      timestamp: 1,
      metadata: { stateless_validator: 'reth', zkvm: 'zisk', zkvm_version: 'v1.10.0' },
      suite_hash: 's2',
      tests: { tests_passed: 10, tests_failed: 0 },
      cost: { base: 40, main: 60 },
    }),
    entry('ethrex', {
      timestamp: 3,
      metadata: { stateless_validator: 'ethrex', zkvm: 'zisk', zkvm_version: 'v1.2.0-alpha' },
      image: 'ghcr.io/eth-act/ere/ere-server-zisk:0.18.0',
      tests: { tests_passed: 5, tests_failed: 2 },
      cost: { main: 100 },
    }),
    entry('unlabelled', {
      timestamp: 2,
      metadata: undefined,
      image: 'ghcr.io/eth-act/ere/ere-server-openvm:0.18.0',
      suite_hash: 's3',
      tests: { tests_passed: 0, tests_failed: 4 },
      cost: {},
    }),
  ]
  const suiteSizes = new Map([
    ['s1', 30],
    ['s2', 20],
  ])

  // Each column lists the ascending order and then the descending one. A missing value goes last both ways.
  const cases: [EstimateSortColumn, string[], string[]][] = [
    ['timestamp', ['reth', 'unlabelled', 'ethrex'], ['ethrex', 'unlabelled', 'reth']],
    ['subject', ['ethrex', 'unlabelled', 'reth'], ['reth', 'unlabelled', 'ethrex']],
    ['version', ['ethrex', 'reth', 'unlabelled'], ['reth', 'ethrex', 'unlabelled']],
    ['image', ['unlabelled', 'ethrex', 'reth'], ['reth', 'ethrex', 'unlabelled']],
    ['suite', ['ethrex', 'reth', 'unlabelled'], ['unlabelled', 'reth', 'ethrex']],
    ['failed', ['reth', 'ethrex', 'unlabelled'], ['unlabelled', 'ethrex', 'reth']],
    ['passed', ['unlabelled', 'ethrex', 'reth'], ['reth', 'ethrex', 'unlabelled']],
    ['total', ['reth', 'ethrex', 'unlabelled'], ['ethrex', 'reth', 'unlabelled']],
    ['cost', ['reth', 'ethrex', 'unlabelled'], ['ethrex', 'reth', 'unlabelled']],
  ]

  for (const [column, ascending, descending] of cases) {
    it(`sorts on ${column} either way`, () => {
      const ids = (sortDir: 'asc' | 'desc') => sortEstimates(entries, column, sortDir, suiteSizes).map((sorted) => sorted.estimate_id)

      expect(ids('asc')).toEqual(ascending)
      expect(ids('desc')).toEqual(descending)
    })
  }
})

describe('selectionBlocker', () => {
  const picked = entry('reth')
  const older = entry('zesu', { metadata: { stateless_validator: 'zesu', zkvm: 'zisk', zkvm_version: 'v1.2.0-alpha' } })

  it('blocks nothing before the first pick', () => {
    expect(selectionBlocker(older, [])).toBeUndefined()
  })

  it('lets another zkVM version join', () => {
    expect(selectionBlocker(older, [picked])).toBeUndefined()
  })

  it('blocks another zkVM', () => {
    const openvm = entry('ethrex', { metadata: { stateless_validator: 'ethrex', zkvm: 'openvm', zkvm_version: 'v1.3.0-alpha' } })

    expect(selectionBlocker(openvm, [picked])).toBe('Cannot compare costs across zkVMs')
    expect(selectionBlocker(openvm, [])).toBeUndefined()
  })

  it('blocks a new pick at the limit but never a picked row', () => {
    const picks = Array.from({ length: MAX_COMPARE_RUNS }, (_, at) => entry(`pick${at}`))

    expect(selectionBlocker(entry('ethrex'), picks)).toBe(`Cannot compare more than ${MAX_COMPARE_RUNS} estimates`)
    expect(selectionBlocker(picks[0], picks)).toBeUndefined()
  })
})

describe('spansSuites', () => {
  it('reports a selection with more than one suite', () => {
    expect(spansSuites([entry('reth'), entry('ethrex')])).toBe(false)
    expect(spansSuites([entry('reth'), entry('ethrex', { suite_hash: 's2' })])).toBe(true)
  })
})

describe('spansEreTags', () => {
  it('reports a selection with more than one ere tag', () => {
    expect(spansEreTags([])).toBe(false)
    expect(spansEreTags([entry('reth'), entry('ethrex', { metadata: { zkvm: 'zisk', zkvm_version: 'v1.2.0-alpha' } })])).toBe(false)
    expect(spansEreTags([entry('reth'), entry('ethrex', { image: 'ghcr.io/eth-act/ere/ere-server-zisk:0.18.0' })])).toBe(true)
  })
})

describe('availableLabels', () => {
  it('lists the values of every label key in order', () => {
    const labels = availableLabels([
      entry('reth', { metadata: { zkvm: 'zisk', zkvm_version: 'v1.3.0-alpha' } }),
      entry('ethrex', { metadata: { zkvm: 'openvm', zkvm_version: 'v1.3.0-alpha' } }),
      entry('unlabelled', { metadata: undefined }),
    ])

    expect(Object.fromEntries(labels)).toEqual({ zkvm: ['openvm', 'zisk'], zkvm_version: ['v1.3.0-alpha'] })
  })
})

describe('estimateCompareRun', () => {
  it('carries the header of the estimate as the config of a run', () => {
    const estimate: RunEstimate = {
      timestamp: 1790390784,
      suite_hash: 'f585281e3fea89a8',
      instance: { id: 'reth-zisk', client: 'provoor' },
      metadata: { labels: { zkvm: 'zisk', zkvm_version: 'v1.3.0-alpha' } },
      zkvm: 'zisk',
      image: 'ghcr.io/eth-act/ere/ere-server-zisk:77e2aae',
      elf_url: 'https://example.invalid/guest.elf',
      elf_sha256: '00',
      tests: {},
    }
    const run = estimateCompareRun('1790390784_ccecd858_reth-zisk', estimate, 1)

    expect(run).toEqual({
      runId: '1790390784_ccecd858_reth-zisk',
      config: {
        timestamp: 1790390784,
        suite_hash: 'f585281e3fea89a8',
        instance: { id: 'reth-zisk', client: 'provoor' },
        metadata: { labels: { zkvm: 'zisk', zkvm_version: 'v1.3.0-alpha' } },
      },
      result: null,
      index: 1,
    })
    expect(formatRunLabel(RUN_SLOTS[run.index], run, 'label:zkvm_version')).toBe('B (v1.3.0-alpha)')
  })
})

import type { BlockLogs, RunEstimate, SuiteTest } from '@/api/types'
import { groupNames, type ComparedValue } from '@/components/compare/estimateComparison'
import { measuredTimeMs } from '@/utils/blockLogs'
import { costPoints, deviation, fitted, keptTests, sortNullsLast, suiteOrder, type Fit } from '@/utils/estimate'
import type { SortOrder, TestCategory } from '../../block-logs-dashboard/types'
import { parseCategory } from '../../block-logs-dashboard/utils/categoryParser'
import { emptyCategoryBreakdown } from '../../block-logs-dashboard/utils/statistics'
import type { DimensionRow, DimensionSortField, EstimateDimension, EstimateRow, EstimateSortField, EstimateState } from '../types'

export interface EstimateInput {
  estimate: RunEstimate
  blockLogs?: BlockLogs | null
  /** Selects the proved time rather than the executed time. */
  isProving: boolean
  /** Every cost kind of the estimate, in the order the columns print. */
  kinds: string[]
  /** Suite tests in canonical run order, so Test # matches the other charts. */
  suiteTests?: SuiteTest[]
  /** Only tests whose name matches this query are read. */
  searchQuery?: string
  /** Only tests this accepts are read, which carries the status filter of the page. */
  includeTest?: (testName: string) => boolean
  /** The fields of the state that filter or fit the rows. */
  state: Pick<EstimateState, 'categories' | 'minThroughput' | 'maxThroughput' | 'minCost' | 'maxCost' | 'fitModel'>
}

export interface EstimateData {
  /** The rows the filters keep, in run order. */
  rows: EstimateRow[]
  /** The failed tests the page filters and the category keep, in suite order. */
  failures: string[]
  /** The line over the timed rows, null where none is timed. */
  fit: Fit | null
  /** Tests per category over every estimated test the page filters keep. */
  breakdown: Record<TestCategory, number>
  /** The fastest throughput the run logged for an estimated test, null where it logged none. */
  maxThroughput: number | null
  /** The lowest estimated cost of the tests the page filters keep, null where they keep none. */
  minCost: number | null
  /** The highest estimated cost of the tests the page filters keep, null where they keep none. */
  maxCost: number | null
  /** Passed tests the page filters keep, before the bar filters. */
  passed: number
  /** Failed tests the page filters keep. */
  failed: number
  /** Suite tests the page filters keep that neither passed nor failed in the estimate. */
  missing: number
  /** Whether the block logs time any estimated test, which is what the throughput filter and the fit read. */
  hasTiming: boolean
}

/** A figure the row lacks prints as a dash. */
export const orDash = (value: number | null, format: (value: number) => string) => (value === null ? '-' : format(value))

const sortValue = (row: EstimateRow, field: EstimateSortField, kinds: string[]): number | string | null => {
  switch (field) {
    case 'order':
      return row.testNumber
    case 'name':
      return row.testName
    case 'cost':
      return row.total
    case 'heap':
      return row.peakHeapBytes
    case 'time':
      return row.timeMs
    case 'fitted':
      return row.fittedMs
    case 'error':
      return row.error
    default: {
      const at = kinds.indexOf(field.slice('kind:'.length))
      return at < 0 ? null : row.costs[at]
    }
  }
}

/** The rows in the order of the sort, a row without the figure going last whichever way the column runs. */
export function sortRows(rows: EstimateRow[], kinds: string[], state: EstimateState): EstimateRow[] {
  return sortNullsLast(rows, (row) => sortValue(row, state.sortBy, kinds), state.sortOrder)
}

/**
 * The kept rows grouped by the dimension of the key as groupNames groups them,
 * each group counting the kept failures it holds. The largest and the mean
 * figure read the compared value, so a group with no test that reports it has
 * neither.
 */
export function summariseByDimension(
  rows: EstimateRow[],
  failures: string[],
  dimension: EstimateDimension,
  kinds: string[],
  signedError: boolean,
  comparedValue: ComparedValue,
): DimensionRow[] {
  const keptTotal = rows.reduce((sum, row) => sum + row.total, 0)
  const rowOf = new Map(rows.map((row) => [row.testName, row]))

  return [...groupNames([...rowOf.keys(), ...failures], dimension)].map(([value, names]) => {
    const held = names.flatMap((name) => rowOf.get(name) ?? [])
    const failed = names.length - held.length
    const total = held.reduce((sum, row) => sum + row.total, 0)
    const kindTotals = kinds.map((_kind, at) => held.reduce((sum, row) => sum + row.costs[at], 0))
    const errors = held.flatMap((row) => (row.error === null ? [] : [signedError ? row.error : Math.abs(row.error)]))
    const figures = held.flatMap((row) => {
      const figure = comparedValue === 'cost' ? row.total : row.peakHeapBytes
      return figure === null ? [] : [figure]
    })
    const tests = held.length

    return {
      value,
      tests,
      failed,
      max: figures.length > 0 ? Math.max(...figures) : null,
      mean: figures.length > 0 ? figures.reduce((sum, figure) => sum + figure, 0) / figures.length : null,
      share: tests > 0 ? total / (keptTotal || 1) : null,
      kindShares: kindTotals.map((kindTotal) => (total > 0 ? kindTotal / total : null)),
      kindMeans: kindTotals.map((kindTotal) => (tests > 0 ? kindTotal / tests : null)),
      error: errors.length > 0 ? errors.reduce((sum, error) => sum + error, 0) / errors.length : null,
    }
  })
}

const dimensionSortValue = (row: DimensionRow, field: DimensionSortField, kinds: string[], costShare: boolean): number | string | null => {
  switch (field) {
    case 'value':
      return row.value
    case 'tests':
      return row.tests
    case 'failed':
      return row.failed
    case 'max':
      return row.max
    case 'mean':
      return row.mean
    case 'share':
      return row.share
    case 'error':
      return row.error
    default: {
      const at = kinds.indexOf(field.slice('kind:'.length))
      return at < 0 ? null : costShare ? row.kindShares[at] : row.kindMeans[at]
    }
  }
}

/** The groups in the order of the sort, a group without the figure going last whichever way the column runs. */
export function sortDimensionRows(rows: DimensionRow[], kinds: string[], sortBy: DimensionSortField, sortOrder: SortOrder, costShare: boolean): DimensionRow[] {
  return sortNullsLast(rows, (row) => dimensionSortValue(row, sortBy, kinds, costShare), sortOrder)
}

/**
 * estimateData reads the estimated tests the page filters keep, drops those the
 * bar filters exclude, and fits the measured time of the rest against their
 * cost. A test timed at zero says nothing about its cost and divides a
 * relative fit by zero, so it counts as untimed.
 */
export function estimateData({ estimate, blockLogs, isProving, kinds, suiteTests, searchQuery, includeTest, state }: EstimateInput): EstimateData {
  const passed = costPoints(estimate, kinds, { suiteTests, searchQuery, includeTest }).map((point) => {
    const entry = blockLogs?.[point.testName]
    const timeMs = entry ? measuredTimeMs(entry, isProving) : 0

    return {
      ...point,
      category: parseCategory(point.testName),
      throughput: entry?.throughput?.mgas_per_sec ?? null,
      timeMs: timeMs > 0 ? timeMs : null,
      fittedMs: null,
      error: null,
    }
  })

  const breakdown = emptyCategoryBreakdown()
  for (const row of passed) breakdown[row.category]++
  const throughputs = passed.flatMap((row) => (row.throughput === null ? [] : [row.throughput]))
  const costs = passed.map((row) => row.total)

  const failed = keptTests(Object.keys(estimate.failures ?? {}), { searchQuery, includeTest })
  // An estimate with no estimated test shows no filter bar, so the category filter does not apply.
  const categories = kinds.length === 0 ? [] : state.categories
  const keeps = (category: TestCategory) => categories.length === 0 || categories.includes(category)

  // The throughput range applies only where the bar shows it, which is where the block logs time an estimated test.
  const hasTiming = blockLogs != null && passed.some((row) => blockLogs[row.testName] !== undefined)
  const kept = passed.filter(
    (row) =>
      keeps(row.category) &&
      (!hasTiming || state.minThroughput === undefined || (row.throughput ?? 0) >= state.minThroughput) &&
      (!hasTiming || state.maxThroughput === undefined || (row.throughput ?? 0) <= state.maxThroughput) &&
      (state.minCost === undefined || row.total >= state.minCost) &&
      (state.maxCost === undefined || row.total <= state.maxCost),
  )
  const timed = kept.flatMap((row) => (row.timeMs === null ? [] : [{ cost: row.total, timeMs: row.timeMs }]))
  const fit = timed.length > 0 ? fitted(timed, state.fitModel) : null

  // The chart places a row by its index among the rows it draws.
  const rows = kept.map((row, at) => {
    const fittedMs = fit === null ? null : fit.predicted(row.total)

    return { ...row, testIndex: at + 1, fittedMs, error: fittedMs === null || row.timeMs === null ? null : deviation(row.timeMs, fittedMs) }
  })

  const missing = keptTests(suiteTests?.map((test) => test.name) ?? [], { searchQuery, includeTest }).filter(
    (testName) => estimate.tests[testName] === undefined && estimate.failures?.[testName] === undefined,
  )

  return {
    rows,
    failures: failed
      .filter((testName) => keeps(parseCategory(testName)))
      .sort(suiteOrder(suiteTests).compare),
    fit,
    breakdown,
    maxThroughput: throughputs.length > 0 ? Math.max(...throughputs) : null,
    minCost: costs.length > 0 ? Math.min(...costs) : null,
    maxCost: costs.length > 0 ? Math.max(...costs) : null,
    passed: passed.length,
    failed: failed.length,
    missing: missing.length,
    hasTiming,
  }
}

import type { BlockLogs, RunEstimate, SuiteTest } from '@/api/types'
import { measuredTimeMs } from '@/utils/blockLogs'
import { costPoints, costShare, deviation, fitted, type Fit } from '@/utils/estimate'
import type { TestCategory } from '../../block-logs-dashboard/types'
import { parseCategory } from '../../block-logs-dashboard/utils/categoryParser'
import { emptyCategoryBreakdown } from '../../block-logs-dashboard/utils/statistics'
import type { EstimateRow, EstimateSortField, EstimateState } from '../types'

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
  state: EstimateState
}

export interface EstimateData {
  /** The rows the filters keep, in run order. */
  rows: EstimateRow[]
  /** The rows in the order the table prints them. */
  sorted: EstimateRow[]
  /** The line over the timed rows, null where none is timed. */
  fit: Fit | null
  /** Tests per category over every priced test the page filters keep. */
  breakdown: Record<TestCategory, number>
  /** The fastest throughput the run logged for a priced test, null where it logged none. */
  maxThroughput: number | null
  /** Priced tests the page filters keep, before the bar filters. */
  priced: number
  /** Whether the block logs time any priced test, which is what the throughput filter and the fit read. */
  hasTiming: boolean
}

const sortValue = (row: EstimateRow, field: EstimateSortField, kinds: string[], state: EstimateState): number | string | null => {
  switch (field) {
    case 'order':
      return row.testNumber
    case 'category':
      return row.category
    case 'cost':
      return row.total
    case 'time':
      return row.timeMs
    case 'fitted':
      return row.fittedMs
    case 'error':
      return row.error === null ? null : state.signedError ? row.error : Math.abs(row.error)
    default: {
      const at = kinds.indexOf(field.slice('kind:'.length))
      return at < 0 ? null : state.costShare ? row.shares[at] : row.costs[at]
    }
  }
}

/** The rows in the order of the sort, a row without the figure going last whichever way the column runs. */
export function sortRows(rows: EstimateRow[], kinds: string[], state: EstimateState): EstimateRow[] {
  const direction = state.sortOrder === 'asc' ? 1 : -1

  return [...rows].sort((a, b) => {
    const left = sortValue(a, state.sortBy, kinds, state)
    const right = sortValue(b, state.sortBy, kinds, state)
    if (left === null || right === null) return left === right ? 0 : left === null ? 1 : -1

    return (typeof left === 'string' ? left.localeCompare(right as string) : left - (right as number)) * direction
  })
}

/**
 * estimateData reads the priced tests the page filters keep, drops those the
 * bar filters exclude, and fits the measured time of the rest against their
 * cost. A test timed at zero says nothing about its cost and divides a
 * relative fit by zero, so it counts as untimed.
 */
export function estimateData({ estimate, blockLogs, isProving, kinds, suiteTests, searchQuery, includeTest, state }: EstimateInput): EstimateData {
  const priced = costPoints(estimate, kinds, { suiteTests, searchQuery, includeTest }).map((point) => {
    const entry = blockLogs?.[point.testName]
    const timeMs = entry ? measuredTimeMs(entry, isProving) : 0

    return {
      ...point,
      category: parseCategory(point.testName),
      shares: kinds.map((kind) => costShare(estimate.tests[point.testName].cost, kind) ?? null),
      throughput: entry?.throughput?.mgas_per_sec ?? null,
      timeMs: timeMs > 0 ? timeMs : null,
      fittedMs: null,
      error: null,
    }
  })

  const breakdown = emptyCategoryBreakdown()
  for (const row of priced) breakdown[row.category]++
  const throughputs = priced.flatMap((row) => (row.throughput === null ? [] : [row.throughput]))

  const kept = priced.filter(
    (row) =>
      (state.categories.length === 0 || state.categories.includes(row.category)) &&
      (state.minThroughput === undefined || (row.throughput ?? 0) >= state.minThroughput) &&
      (state.maxThroughput === undefined || (row.throughput ?? 0) <= state.maxThroughput),
  )
  const timed = kept.flatMap((row) => (row.timeMs === null ? [] : [{ cost: row.total, timeMs: row.timeMs }]))
  const fit = timed.length > 0 ? fitted(timed, state.fitModel) : null

  // The chart places a row by its index among the rows it draws.
  const rows = kept.map((row, at) => {
    const fittedMs = fit === null ? null : fit.predicted(row.total)

    return { ...row, testIndex: at + 1, fittedMs, error: fittedMs === null || row.timeMs === null ? null : deviation(row.timeMs, fittedMs) }
  })

  return {
    rows,
    sorted: sortRows(rows, kinds, state),
    fit,
    breakdown,
    maxThroughput: throughputs.length > 0 ? Math.max(...throughputs) : null,
    priced: priced.length,
    hasTiming: blockLogs != null && priced.some((row) => blockLogs[row.testName] !== undefined),
  }
}

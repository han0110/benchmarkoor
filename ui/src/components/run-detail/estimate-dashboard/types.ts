import type { CostDataPoint, FitModelKey } from '@/utils/estimate'
import type { SortOrder, TestCategory } from '../block-logs-dashboard/types'

export type EstimateTab = 'overview' | 'distribution' | 'correlation'

/** The sort fields of the table, with one per cost kind under the kind prefix. */
export type EstimateSortField = 'order' | 'name' | 'cost' | 'heap' | 'time' | 'fitted' | 'error' | `kind:${string}`

export interface EstimateState {
  activeTab: EstimateTab
  /** The selected categories, empty for all of them. */
  categories: TestCategory[]
  minThroughput?: number
  maxThroughput?: number
  minCost?: number
  maxCost?: number
  sortBy: EstimateSortField
  sortOrder: SortOrder
  /** Prints each kind of the group table as its share of the group rather than as its mean cost. */
  costShare: boolean
  /** Prints the fitted error of the group table signed rather than unsigned. */
  signedError: boolean
  fitModel: FitModelKey
}

/** One estimated test the filters keep, with the block log figures where the run logged the test. */
export interface EstimateRow extends CostDataPoint {
  category: TestCategory
  throughput: number | null
  /** The measured time, null where the block logs hold none or time the test at zero. */
  timeMs: number | null
  /** The time the fit predicts, null where no test is timed. */
  fittedMs: number | null
  /** The signed deviation of the measured time from the fitted one, null where the test is not timed. */
  error: number | null
}

/** The filter key of the part of the test name the group table groups by. */
export type EstimateDimension = string

/** The sort fields of the group table, with one per cost kind under the kind prefix. */
export type DimensionSortField = 'value' | 'tests' | 'failed' | 'max' | 'mean' | 'share' | 'error' | `kind:${string}`

/** The kept tests that share one group of a part of the test name. */
export interface DimensionRow {
  value: string
  /** Passed tests of the group. */
  tests: number
  /** Failed tests of the group. */
  failed: number
  /** The largest total cost or peak heap, null where no test of the group reports it. */
  max: number | null
  /** The mean total cost or peak heap, null where no test of the group reports it. */
  mean: number | null
  /** The share of the kept cost the group holds, null where every test of the group failed. */
  share: number | null
  /** One share of the group cost per kind, null where the group costs nothing. */
  kindShares: (number | null)[]
  /** One mean cost per kind, null where every test of the group failed. */
  kindMeans: (number | null)[]
  /** The mean fit error of the timed tests, signed or unsigned, null where no test of the group is timed. */
  error: number | null
}

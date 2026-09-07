import type { CostDataPoint, FitModelKey } from '@/utils/estimate'
import type { SortOrder, TestCategory } from '../block-logs-dashboard/types'

export type EstimateTab = 'overview' | 'distribution' | 'correlation'

/** The sort fields of the table, with one per cost kind under the kind prefix. */
export type EstimateSortField = 'order' | 'category' | 'cost' | 'time' | 'fitted' | 'error' | `kind:${string}`

export interface EstimateState {
  activeTab: EstimateTab
  /** The selected categories, empty for all of them. */
  categories: TestCategory[]
  minThroughput?: number
  maxThroughput?: number
  sortBy: EstimateSortField
  sortOrder: SortOrder
  /** Prints each kind as its share of the test rather than as its cost. */
  costShare: boolean
  /** Prints the error of the table signed, where it reads unsigned by default. */
  signedError: boolean
  fitModel: FitModelKey
}

/** One priced test the filters keep, with the block log figures where the run logged the test. */
export interface EstimateRow extends CostDataPoint {
  category: TestCategory
  /** One share per kind, in the order of the kinds, null where the test costs nothing. */
  shares: (number | null)[]
  throughput: number | null
  /** The measured time, null where the block logs hold none or time the test at zero. */
  timeMs: number | null
  /** The time the fit predicts, null where no test is timed. */
  fittedMs: number | null
  /** The signed deviation of the measured time from the fitted one, null where the test is not timed. */
  error: number | null
}

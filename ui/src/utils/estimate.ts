import type { RunEstimate, SuiteTest } from '@/api/types'
import { compileQuery } from './eestNameFilter'
import { formatDurationMs } from './format'

/** Sums the cost kinds, in the unit the zkVM prices in. */
export function costTotal(cost: Record<string, number>): number {
  return Object.values(cost).reduce((sum, value) => sum + value, 0)
}

/** Share one kind takes of a cost. Undefined where the cost is zero and no kind holds a share of it. */
export function costShare(cost: Record<string, number>, kind: string): number | undefined {
  const total = costTotal(cost)
  return total === 0 ? undefined : (cost[kind] ?? 0) / total
}

/** Every cost kind the estimates name, in the order the kinds are first seen. */
export function costKinds(estimates: RunEstimate[]): string[] {
  const kinds = new Set<string>()
  for (const estimate of estimates) {
    for (const test of Object.values(estimate.tests)) {
      for (const kind of Object.keys(test.cost)) kinds.add(kind)
    }
  }
  return [...kinds]
}

/** Test names every estimate holds, which is the population a comparison reads. */
export function sharedTestNames(estimates: RunEstimate[]): string[] {
  const [first, ...rest] = estimates
  return Object.keys(first.tests)
    .filter((name) => rest.every((estimate) => estimate.tests[name] != null))
    .sort()
}

/** Reports whether any test of the estimate carries a peak heap, which only some servers report. */
export function reportsHeap(estimate: RunEstimate): boolean {
  return Object.values(estimate.tests).some((test) => test.peak_heap_bytes != null)
}

/** Reports whether one zkVM priced every estimate. */
export function sameZkvm(estimates: (RunEstimate | null)[]): boolean {
  const zkvms = estimates.flatMap((estimate) => (estimate ? [estimate.zkvm] : []))
  return zkvms.every((zkvm) => zkvm === zkvms[0])
}

export interface FitPoint {
  cost: number
  timeMs: number
}

interface Line {
  slope: number
  intercept: number
}

function leastSquares(points: FitPoint[]): Line {
  const mean = (of: (point: FitPoint) => number) => points.reduce((sum, point) => sum + of(point), 0) / points.length
  const meanCost = mean((point) => point.cost)
  const meanTime = mean((point) => point.timeMs)
  const spread = points.reduce((sum, point) => sum + (point.cost - meanCost) ** 2, 0)
  const covariance = points.reduce((sum, point) => sum + (point.cost - meanCost) * (point.timeMs - meanTime), 0)
  // A single cost leaves no spread, so the line is flat at the mean time.
  const slope = spread === 0 ? 0 : covariance / spread
  return { slope, intercept: meanTime - slope * meanCost }
}

// relativeSquares minimises the squared residual of each test divided by its own measured time, so every test weighs the same.
function relativeSquares(points: FitPoint[]): Line {
  const sum = (values: number[]) => values.reduce((total, value) => total + value, 0)
  const inverses = points.map((point) => 1 / point.timeMs)
  const inverseSquares = sum(inverses.map((inverse) => inverse * inverse))
  const inverseTotal = sum(inverses)
  // One cost across the points makes the normal equations singular, so the times alone give the line.
  if (points.every((point) => point.cost === points[0].cost)) {
    return { slope: 0, intercept: inverseTotal / inverseSquares }
  }
  const rates = points.map((point) => point.cost / point.timeMs)
  const rateSquares = sum(rates.map((rate) => rate * rate))
  const products = sum(rates.map((rate, at) => rate * inverses[at]))
  const rateTotal = sum(rates)
  const determinant = rateSquares * inverseSquares - products * products
  return {
    slope: (rateTotal * inverseSquares - inverseTotal * products) / determinant,
    intercept: (inverseTotal * rateSquares - rateTotal * products) / determinant,
  }
}

export type FitModelKey = 'relative-squares' | 'least-squares'

// Least squares minimises the squared residual in milliseconds against the measured time, so a long test weighs more than a short one.
const FIT_MODELS_BY_KEY: Record<FitModelKey, { label: string; of: (points: FitPoint[]) => Line }> = {
  'relative-squares': { label: 'Relative least squares', of: relativeSquares },
  'least-squares': { label: 'Least squares', of: leastSquares },
}

export const FIT_MODELS = Object.entries(FIT_MODELS_BY_KEY).map(([value, { label }]) => ({
  value: value as FitModelKey,
  label,
}))

// The share is taken of the measured time, because a fit can predict a time below zero.
export const deviation = (measured: number, predicted: number): number => (measured - predicted) / measured

/** Cost the slope is stated per. */
const COST_UNIT = 1e9

export interface Fit extends Line {
  predicted: (cost: number) => number
  /** Share of the spread in the measured times the fit accounts for. */
  determination: number
  /** Deviation of every point, in the order the points were given. */
  deviations: number[]
}

/** Fits a line over the points and reports how far each point sits from it. */
export function fitted(points: FitPoint[], model: FitModelKey): Fit {
  const line = FIT_MODELS_BY_KEY[model].of(points)
  const predicted = (cost: number) => line.intercept + line.slope * cost
  const meanTime = points.reduce((sum, point) => sum + point.timeMs, 0) / points.length
  const spread = points.reduce((sum, point) => sum + (point.timeMs - meanTime) ** 2, 0)
  const residual = points.reduce((sum, point) => sum + (point.timeMs - predicted(point.cost)) ** 2, 0)
  return {
    ...line,
    predicted,
    determination: spread === 0 ? 0 : 1 - residual / spread,
    deviations: points.map((point) => deviation(point.timeMs, predicted(point.cost))),
  }
}

/** One test the estimate prices and the block logs time. */
export interface CostPoint extends FitPoint {
  testName: string
}

/** The page filters, so every panel of a run reads the same tests. */
interface TestFilter {
  /** Only tests whose name matches this query are read. */
  searchQuery?: string
  /** Only tests this accepts are read, which carries the status filter of the page. */
  includeTest?: (testName: string) => boolean
}

/** The names the page filters keep. */
export function keptTests(names: string[], { searchQuery, includeTest }: TestFilter): string[] {
  const matches = compileQuery(searchQuery ?? '')
  return names.filter((name) => matches(name) && (!includeTest || includeTest(name)))
}

/** One test priced by kind, in the order the run executed the tests. */
export interface CostDataPoint {
  testIndex: number
  testNumber: number
  testName: string
  /** One figure per kind, in the order the kinds are given. */
  costs: number[]
  total: number
  peakHeapBytes: number | null
}

interface CostPointOptions extends TestFilter {
  /** Suite tests in canonical run order, so Test # matches the other charts. */
  suiteTests?: SuiteTest[]
}

/** The priced tests the page filters keep, in run order, the tests the suite does not list going last. */
export function costPoints(
  estimate: RunEstimate,
  kinds: string[],
  { suiteTests, ...filter }: CostPointOptions = {},
): CostDataPoint[] {
  const order = new Map<string, number>()
  suiteTests?.forEach((test, position) => {
    order.set(test.name, position + 1)
  })

  return keptTests(Object.keys(estimate.tests), filter)
    .sort((left, right) => {
      const leftOrder = order.get(left) ?? Number.MAX_SAFE_INTEGER
      const rightOrder = order.get(right) ?? Number.MAX_SAFE_INTEGER
      if (leftOrder !== rightOrder) return leftOrder - rightOrder

      return left.localeCompare(right)
    })
    .map((testName, position) => {
      const test = estimate.tests[testName]
      return {
        testIndex: position + 1,
        testNumber: order.get(testName) ?? position + 1,
        testName,
        costs: kinds.map((kind) => test.cost[kind] ?? 0),
        total: costTotal(test.cost),
        peakHeapBytes: test.peak_heap_bytes ?? null,
      }
    })
}

const SI_STEPS: [number, string][] = [
  [1e12, 'T'],
  [1e9, 'G'],
  [1e6, 'M'],
  [1e3, 'k'],
]

/** A cost, which runs to tens of billions and so reads in SI steps. */
export function formatCost(value: number): string {
  for (const [limit, suffix] of SI_STEPS) {
    if (Math.abs(value) >= limit) return `${(value / limit).toFixed(2)}${suffix}`
  }
  return value.toFixed(0)
}

/** The slope, as the seconds a billion of cost takes. */
export const formatRate = (slope: number): string => `${((slope * COST_UNIT) / 1000).toFixed(3)} s/G`

/** A duration that reads on either side of zero, since a fit can place its intercept below it. */
export const formatSignedDuration = (milliseconds: number): string =>
  milliseconds < 0 ? `-${formatDurationMs(-milliseconds)}` : formatDurationMs(milliseconds)

export const formatPercent = (share: number): string => `${(share * 100).toFixed(1)}%`

export const formatSignedPercent = (share: number): string =>
  `${share < 0 ? '-' : '+'}${formatPercent(Math.abs(share))}`

/** Classes a signed share prints in, matching the comparison deltas. */
export const deviationClass = (share: number): string =>
  share === 0
    ? 'text-gray-400 dark:text-gray-500'
    : share < 0
      ? 'text-green-600 dark:text-green-400'
      : 'text-red-600 dark:text-red-400'

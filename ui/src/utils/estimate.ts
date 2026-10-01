import type { RunEstimate, SuiteTest } from '@/api/types'
import { compileQuery } from './eestNameFilter'
import { formatDurationMs, formatNumber } from './format'

/** Sums the cost kinds, in the unit of the zkVM. */
export function costTotal(cost: Record<string, number>): number {
  return Object.values(cost).reduce((sum, value) => sum + value, 0)
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

/** Reports whether the estimates share the zkvm label, which puts their costs on one scale whatever the zkvm_version. */
export function sameZkvm(estimates: RunEstimate[]): boolean {
  const [first, ...rest] = estimates.map((estimate) => estimate.metadata.labels?.zkvm)
  return rest.every((zkvm) => zkvm === first)
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

/** One estimated test that the block logs time. */
export interface CostPoint extends FitPoint {
  testName: string
}

/** The page filters, so every panel of the page reads the same tests. */
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

/** The 1-based position of each suite test, and a comparator in suite order. The comparator puts the tests the suite does not list last, in name order. */
export function suiteOrder(suiteTests: SuiteTest[] | undefined) {
  const positions = new Map(suiteTests?.map((test, position) => [test.name, position + 1]))
  const positionOf = (testName: string) => positions.get(testName) ?? Number.MAX_SAFE_INTEGER

  return { positions, compare: (left: string, right: string) => positionOf(left) - positionOf(right) || left.localeCompare(right) }
}

/** The items in the order of the value, an item without the value going last whichever way the sort runs. Numeric collation puts v1.10.0 after v1.9.0. */
export function sortNullsLast<Item>(items: Item[], valueOf: (item: Item) => number | string | null, direction: 'asc' | 'desc'): Item[] {
  const sign = direction === 'asc' ? 1 : -1

  return [...items].sort((a, b) => {
    const left = valueOf(a)
    const right = valueOf(b)
    if (left === null || right === null) return left === right ? 0 : left === null ? 1 : -1

    return (typeof left === 'string' ? left.localeCompare(right as string, undefined, { numeric: true }) : left - (right as number)) * sign
  })
}

/** One estimated test with its cost by kind, in suite order. */
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

/** The estimated tests the page filters keep, in run order, the tests the suite does not list going last. */
export function costPoints(
  estimate: RunEstimate,
  kinds: string[],
  { suiteTests, ...filter }: CostPointOptions = {},
): CostDataPoint[] {
  const { positions, compare } = suiteOrder(suiteTests)

  return keptTests(Object.keys(estimate.tests), filter)
    .sort(compare)
    .map((testName, position) => {
      const test = estimate.tests[testName]
      return {
        testIndex: position + 1,
        testNumber: positions.get(testName) ?? position + 1,
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

/** The cost of a text in the SI steps of formatCost in either case, or as a plain number, rounded to an integer. Other text has no cost. */
export function parseCost(text: string): number | undefined {
  const trimmed = text.trim().toLowerCase()
  const [limit, suffix] = SI_STEPS.find((step) => trimmed.endsWith(step[1].toLowerCase())) ?? [1, '']
  const digits = trimmed.slice(0, trimmed.length - suffix.length)
  return /^\d+(\.\d+)?$/.test(digits) ? Math.round(Number(digits) * limit) : undefined
}

/** The title of a cost, the cost rounded to an integer. A null cost has no title. */
export const costTitle = (cost: number | null): string | undefined => (cost === null ? undefined : formatNumber(Math.round(cost)))

/** The slope, as the seconds a billion of cost takes. */
export const formatRate = (slope: number): string => `${((slope * COST_UNIT) / 1000).toFixed(3)} s/G`

/** A duration that reads on either side of zero, since a fit can place its intercept below it. */
export const formatSignedDuration = (milliseconds: number): string =>
  milliseconds < 0 ? `-${formatDurationMs(-milliseconds)}` : formatDurationMs(milliseconds)

export const formatPercent = (share: number): string => `${(share * 100).toFixed(1)}%`

export const formatSignedPercent = (share: number): string => formatSigned(share, formatPercent)

/** A ratio, with fewer decimals as it grows. */
export const formatRatio = (ratio: number): string => `${ratio.toFixed(ratio < 10 ? 2 : ratio < 100 ? 1 : 0)}x`

/** A value with its sign in front of the formatted magnitude, because formatBytes prints a negative value in raw bytes. */
export const formatSigned = (value: number, format: (magnitude: number) => string): string =>
  `${value < 0 ? '-' : '+'}${format(Math.abs(value))}`

/** Classes a signed share prints in, matching the comparison deltas. */
export const deviationClass = (share: number): string =>
  share === 0
    ? 'text-gray-400 dark:text-gray-500'
    : share < 0
      ? 'text-green-600 dark:text-green-400'
      : 'text-red-600 dark:text-red-400'

/** Distance from 1 within which a ratio reads as neither cheaper nor dearer. */
export const NEUTRAL_BAND = 0.02

/** Classes a ratio prints in, gray within the neutral band. The check reads the two band edges, because 0.98 - 1 falls outside the band in floating point. */
export const ratioClass = (ratio: number): string =>
  deviationClass(ratio < 1 - NEUTRAL_BAND ? -1 : ratio > 1 + NEUTRAL_BAND ? 1 : 0)

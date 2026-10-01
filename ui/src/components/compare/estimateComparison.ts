import type { RunEstimate, SuiteTest, TestEstimate } from '@/api/types'
import { percentile } from '@/components/run-detail/block-logs-dashboard/utils/statistics'
import type { SortDirection } from '@/components/runs/sortEntries'
import { parseEESTName } from '@/utils/eestName'
import { queryTermDimension, splitQuery } from '@/utils/eestNameFilter'
import { NEUTRAL_BAND, costTotal, formatCost, sharedTestNames, sortNullsLast, suiteOrder } from '@/utils/estimate'
import { formatBytes } from '@/utils/format'

/** The figure the page compares. */
export type ComparedValue = 'cost' | 'heap'

/** The name and the format of each figure. */
export const COMPARED_VALUES: Record<ComparedValue, { label: string; format: (value: number) => string }> = {
  cost: { label: 'Cost', format: formatCost },
  heap: { label: 'Peak Heap', format: formatBytes },
}

/** The figure of a test, null where the test reports none. */
const testValue = (test: TestEstimate, value: ComparedValue): number | null =>
  value === 'cost' ? costTotal(test.cost) : (test.peak_heap_bytes ?? null)

/** The tests the filter keeps that every estimate has the figure of. Every ratio of the page reads them. */
export function sharedTests(estimates: RunEstimate[], keep: (name: string) => boolean, value: ComparedValue): string[] {
  return sharedTestNames(estimates).filter((name) => keep(name) && estimates.every((estimate) => testValue(estimate.tests[name], value) !== null))
}

/** How one estimate compares with the baseline over the shared tests. */
export interface RatioSummary {
  /** The exponential of the mean log ratio, which weighs every test the same. */
  geomean: number
  /** The sum over the shared tests divided by the sum of the baseline, which weighs a test by its value. */
  sumRatio: number
  p5: number
  p50: number
  p95: number
  /** Tests below the neutral band. */
  cheaper: number
  /** Tests within the neutral band. */
  within: number
  /** Tests above the neutral band. */
  dearer: number
}

/**
 * The ratios of the estimate to the baseline over the shared tests. The per-test
 * ratio reads only a test with a positive value on both sides, and the summary is
 * null where no test has one.
 */
export function ratioSummary(estimate: RunEstimate, baseline: RunEstimate, sharedNames: string[], value: ComparedValue): RatioSummary | null {
  const figures = sharedNames.map((name) => [testValue(estimate.tests[name], value)!, testValue(baseline.tests[name], value)!])
  const ratios = figures
    .filter(([figure, baselineFigure]) => figure > 0 && baselineFigure > 0)
    .map(([figure, baselineFigure]) => figure / baselineFigure)
    .sort((left, right) => left - right)
  if (ratios.length === 0) return null

  const sum = (at: number) => figures.reduce((total, pair) => total + pair[at], 0)
  const cheaper = ratios.filter((ratio) => ratio < 1 - NEUTRAL_BAND).length
  const dearer = ratios.filter((ratio) => ratio > 1 + NEUTRAL_BAND).length

  return {
    geomean: Math.exp(ratios.reduce((total, ratio) => total + Math.log(ratio), 0) / ratios.length),
    sumRatio: sum(0) / sum(1),
    p5: percentile(ratios, 5),
    p50: percentile(ratios, 50),
    p95: percentile(ratios, 95),
    cheaper,
    within: ratios.length - cheaper - dearer,
    dearer,
  }
}

/** One row of the kind table, with one figure per estimate. */
export interface KindRatio {
  /** The mean over the shared tests. */
  means: number[]
  /** The mean divided by the mean of the baseline, null where the baseline mean is zero. */
  ratios: (number | null)[]
}

/** The mean of each kind over the shared tests with its ratio to the baseline, and the same for the total. */
export function kindRatios(
  estimates: RunEstimate[],
  sharedNames: string[],
  kinds: string[],
  baselineIndex: number,
): { kinds: KindRatio[]; total: KindRatio } {
  const means = estimates.map((estimate) =>
    kinds.map((kind) => sharedNames.reduce((sum, name) => sum + (estimate.tests[name].cost[kind] ?? 0), 0) / sharedNames.length),
  )
  const row = (of: (kindMeans: number[]) => number): KindRatio => {
    const values = means.map(of)
    const baseline = values[baselineIndex]
    return { means: values, ratios: values.map((value) => (baseline > 0 ? value / baseline : null)) }
  }

  return {
    kinds: kinds.map((_kind, at) => row((kindMeans) => kindMeans[at])),
    total: row((kindMeans) => kindMeans.reduce((sum, mean) => sum + mean, 0)),
  }
}

/** The tests of one estimate that the filter keeps. */
export interface EstimateCoverage {
  passed: number
  failed: number
  /** Passed tests outside the shared set. */
  outside: number
  /** The share of the cost of the passed tests that the tests outside the shared set hold, null where no test passed. */
  outsideShare: number | null
}

export function estimateCoverage(estimate: RunEstimate, shared: Set<string>, keep: (name: string) => boolean): EstimateCoverage {
  const passed = Object.keys(estimate.tests).filter(keep)
  const outside = passed.filter((name) => !shared.has(name))
  const cost = (names: string[]) => names.reduce((sum, name) => sum + costTotal(estimate.tests[name].cost), 0)
  const passedCost = cost(passed)

  return {
    passed: passed.length,
    failed: Object.keys(estimate.failures ?? {}).filter(keep).length,
    outside: outside.length,
    outsideShare: passedCost > 0 ? cost(outside) / passedCost : null,
  }
}

/** One row of the per-test table. */
export interface ComparedTest {
  testName: string
  testNumber: number
  /** Whether every estimate has a value for the test, which is what a ratio needs. */
  shared: boolean
  /** One value per estimate, null where the estimate has no value for the test. */
  values: (number | null)[]
  /** One guest error per estimate, undefined where the estimate did not fail the test. */
  errors: (string | undefined)[]
}

/** The tests the filter keeps that passed or failed in any estimate, in suite order, the tests the suite does not list going last. */
export function comparedTests(
  estimates: RunEstimate[],
  suiteTests: SuiteTest[] | undefined,
  keep: (name: string) => boolean,
  value: ComparedValue,
): ComparedTest[] {
  const { positions, compare } = suiteOrder(suiteTests)
  const names = new Set(estimates.flatMap((estimate) => [...Object.keys(estimate.tests), ...Object.keys(estimate.failures ?? {})]))
  const testNames = [...names].filter(keep).sort(compare)
  // The tests the suite does not list sort last, so they take the numbers after the suite size in turn.
  const firstUnlisted = testNames.findIndex((testName) => !positions.has(testName))

  return testNames.map((testName, position) => {
    const values = estimates.map((estimate) => {
      const test = estimate.tests[testName]
      return test ? testValue(test, value) : null
    })
    return {
      testName,
      testNumber: positions.get(testName) ?? positions.size + position - firstUnlisted + 1,
      shared: values.every((figure) => figure !== null),
      values,
      errors: estimates.map((estimate) => estimate.failures?.[testName]),
    }
  })
}

/** The figures of one estimate on a test. The ratio and the delta need a shared test with a positive value on both sides. */
export function comparedFigures(row: ComparedTest, at: number, baselineIndex: number) {
  const value = row.values[at]
  const baseline = row.values[baselineIndex]
  const compared = row.shared && value !== null && baseline !== null && value > 0 && baseline > 0

  return { value, ratio: compared ? value / baseline : null, delta: compared ? value - baseline : null }
}

/** A sort of the per-test table, by suite order or by a figure of the estimate at the index. */
export type ComparedSortField = 'order' | `${'value' | 'ratio' | 'delta'}:${number}`

export function sortComparedTests(rows: ComparedTest[], sortBy: ComparedSortField, sortDir: SortDirection, baselineIndex: number): ComparedTest[] {
  if (sortBy === 'order') return sortNullsLast(rows, (row) => row.testNumber, sortDir)
  const [figure, at] = sortBy.split(':') as ['value' | 'ratio' | 'delta', string]

  return sortNullsLast(rows, (row) => comparedFigures(row, Number(at), baselineIndex)[figure], sortDir)
}

/** A part of the test name the shared tests group by. The key is the filter key, so a group toggles the term key=group. */
export interface GroupDimension {
  key: string
  label: string
  /** The number of groups among the tests. */
  groups: number
}

/** The dimensions with a fixed name, which come before the parameters of the test names and the label. */
const NAMED_DIMENSIONS = [
  { key: 'file', label: 'File' },
  { key: 'fn', label: 'Test' },
  { key: 'gas', label: 'Gas' },
  { key: 'opcode', label: 'Opcode' },
  { key: 'fork', label: 'Fork' },
]

/** Every filter key of the test name with its value. Each label is a value of the label key. */
function nameTerms(name: string): [string, string | undefined][] {
  const { file, fn, benchmark, opcode, fork, params, labels } = parseEESTName(name)
  return [
    ['file', file],
    ['fn', fn],
    ['gas', benchmark],
    ['opcode', opcode],
    ['fork', fork],
    ...params.map(({ key, value }): [string, string] => [key, value]),
    ...labels.map((label): [string, string] => ['label', label]),
  ]
}

/**
 * The dimensions with two groups or more among the tests, in the order of the named dimensions, the parameters in name order, and the label.
 * A dimension with one group stays listed while the query holds a term with its canonical key.
 */
export function groupDimensions(names: string[], query: string): GroupDimension[] {
  const groupsByKey = new Map<string, Set<string>>()
  for (const name of names) {
    for (const [key, group] of nameTerms(name)) {
      if (group === undefined) continue
      const groups = groupsByKey.get(key) ?? new Set<string>()
      groupsByKey.set(key, groups.add(group))
    }
  }
  const named = new Set([...NAMED_DIMENSIONS.map(({ key }) => key), 'label'])
  const parameters = [...groupsByKey.keys()].filter((key) => !named.has(key)).sort()
  // The query terms and the term key=_ of each dimension give canonical keys, so gas and benchmark meet at one key.
  const queryKeys = new Set(splitQuery(query).map(queryTermDimension))

  return [...NAMED_DIMENSIONS, ...parameters.map((key) => ({ key, label: key })), { key: 'label', label: 'Label' }]
    .map((dimension) => ({ ...dimension, groups: groupsByKey.get(dimension.key)?.size ?? 0 }))
    .filter(({ key, groups }) => groups > 1 || (groups === 1 && queryKeys.has(queryTermDimension(`${key}=_`))))
}

/** The tests grouped by the dimension of the key. A test without a group in it is left out, and a test with two labels counts in both. */
export function groupNames(names: string[], key: string): Map<string, string[]> {
  const groups = new Map<string, string[]>()
  for (const name of names) {
    for (const [termKey, group] of nameTerms(name)) {
      if (termKey !== key || group === undefined) continue
      const members = groups.get(group)
      if (members) members.push(name)
      else groups.set(group, [name])
    }
  }

  return groups
}

/** The shared tests of one group. */
export interface GroupComparison {
  group: string
  tests: number
  /** One mean per estimate. */
  means: number[]
  /** The group sum of each estimate divided by the group sum of the baseline, null where the baseline sums to zero. */
  ratios: (number | null)[]
}

/** The shared tests grouped by the dimension of the key. */
export function groupComparison(estimates: RunEstimate[], sharedNames: string[], key: string, baselineIndex: number, value: ComparedValue): GroupComparison[] {
  return [...groupNames(sharedNames, key)].map(([group, names]) => {
    const sums = estimates.map((estimate) => names.reduce((sum, name) => sum + testValue(estimate.tests[name], value)!, 0))
    const baseline = sums[baselineIndex]
    return { group, tests: names.length, means: sums.map((sum) => sum / names.length), ratios: sums.map((sum) => (baseline > 0 ? sum / baseline : null)) }
  })
}

/** A sort of the group table, by the group, the test count, or a figure of the estimate at the index. */
export type GroupSortField = 'group' | 'tests' | `${'mean' | 'ratio'}:${number}`

export function sortGroups(groups: GroupComparison[], sortBy: GroupSortField, sortDir: SortDirection): GroupComparison[] {
  if (sortBy === 'group' || sortBy === 'tests') return sortNullsLast(groups, (group) => group[sortBy], sortDir)
  const [figure, at] = sortBy.split(':') as ['mean' | 'ratio', string]

  return sortNullsLast(groups, (group) => (figure === 'mean' ? group.means : group.ratios)[Number(at)], sortDir)
}

/** The sort of a table. The ratio of the first estimate that is not the baseline sorts descending by default. A sort on a column that a baseline change removed falls back to it. */
export function appliedSort<Field extends string>(sort: { sortBy: Field; sortDir: SortDirection } | null, baselineIndex: number): { sortBy: Field; sortDir: SortDirection } {
  return sort && sort.sortBy !== `ratio:${baselineIndex}` && sort.sortBy !== `delta:${baselineIndex}`
    ? sort
    : { sortBy: `ratio:${baselineIndex === 0 ? 1 : 0}` as Field, sortDir: 'desc' }
}

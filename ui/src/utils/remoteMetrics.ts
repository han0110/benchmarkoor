import type { DeviceMetrics, SuiteTest } from '@/api/types'
import { compileQuery } from './eestNameFilter'

/** Gauge columns are stored as the real value multiplied by this. */
export const GAUGE_SCALE = 10000

/** Leading columns precede the metric values in every row of every artifact. */
export const LEADING = {
  scrapes: 'scrapes',
  updates: 'updates',
  durationMs: 'duration_ms',
} as const

export type Row = Array<number | null>

export interface RemoteReductionOptions {
  /** Suite tests in canonical run order, so Test # matches the other charts. */
  suiteTests?: SuiteTest[]
  /** Only tests whose name matches this query are charted. */
  searchQuery?: string
  /** Only tests this accepts are charted, which carries the status filter of the page. */
  includeTest?: (testName: string) => boolean
}

/**
 * columnReader addresses the cells of a columnar artifact by column name.
 *
 * A run recorded before a field was collected has no such column, and a chart
 * over it must be hidden. A flat zero line reads as a real measurement of
 * nothing happening. A null cell is a column the window could not measure,
 * which is not a zero, so measured leaves it out.
 */
export function columnReader(metrics: DeviceMetrics) {
  const index: Record<string, number> = {}
  metrics.columns.forEach((name, position) => {
    index[name] = position
  })

  const has = (name: string) => index[name] !== undefined

  const cell = (row: Row, name: string): number | null => {
    const position = index[name]
    if (position === undefined) return null

    return row[position] ?? null
  }

  const measured = (rows: Row[], name: string, scale = 1): number[] =>
    rows.map((row) => cell(row, name)).filter((value): value is number => value !== null).map((value) => value / scale)

  return { has, cell, measured }
}

/**
 * orderedTests lists the tests of an artifact in execution order, keeping only
 * those the page filters accept.
 */
export function orderedTests(metrics: DeviceMetrics, options: RemoteReductionOptions) {
  const { suiteTests, searchQuery, includeTest } = options
  const matcher = searchQuery ? compileQuery(searchQuery) : null
  const order = new Map<string, number>()
  suiteTests?.forEach((test, position) => {
    order.set(test.name, position + 1)
  })

  const names = Object.keys(metrics.tests)
    .filter((name) => (!matcher || matcher(name)) && (!includeTest || includeTest(name)))
    .sort((a, b) => {
      const left = order.get(a) ?? Number.MAX_SAFE_INTEGER
      const right = order.get(b) ?? Number.MAX_SAFE_INTEGER
      if (left !== right) return left - right

      return a.localeCompare(b)
    })

  return { names, order }
}

export const sum = (values: number[]) => values.reduce((total, value) => total + value, 0)
export const mean = (values: number[]) => (values.length > 0 ? sum(values) / values.length : null)
export const max = (values: number[]) => (values.length > 0 ? Math.max(...values) : null)
export const min = (values: number[]) => (values.length > 0 ? Math.min(...values) : null)
export const scaled = (value: number | null, factor: number) => (value === null ? null : value * factor)
export const higher = (current: number | null, value: number | null) =>
  value === null ? current : current === null ? value : Math.max(current, value)
export const lower = (current: number | null, value: number | null) =>
  value === null ? current : current === null ? value : Math.min(current, value)

/**
 * ratioPerDevice reads a counter against the reference counter of the same
 * device, over the devices that carry both. The mean is the mean of the per
 * device ratios. A node with more cores or a GPU at a higher clock therefore
 * weighs no more than a small one. A device whose reference did not move gave
 * nothing to sample, so it takes no part.
 */
export function ratioPerDevice(rows: Row[], cell: (row: Row, name: string) => number | null, numerator: string, denominator: string) {
  const ratios = rows.flatMap((row) => {
    const over = cell(row, numerator)
    const under = cell(row, denominator)

    return over !== null && under !== null && under > 0 ? [over / under] : []
  })

  return {
    mean: scaled(mean(ratios), 100),
    busiest: scaled(max(ratios), 100),
    busy: ratios.filter((ratio) => ratio > 0).length,
  }
}

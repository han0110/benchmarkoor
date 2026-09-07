import { useMemo } from 'react'
import type { ProcessedTestData, DashboardStats, TestCategory } from '../types'
import { BoxPlotChart } from '../charts/BoxPlotChart'
import { HistogramChart } from '../charts/HistogramChart'
import { ALL_CATEGORIES, CATEGORY_COLORS } from '../utils/colors'
import { percentile, summariseByCategory, type CategorySummary as CategoryGroup } from '../utils/statistics'

interface DistributionTabProps {
  data: ProcessedTestData[]
  stats: DashboardStats | null
  isDark: boolean
  useLogScale: boolean
}

interface PercentileCardProps {
  label: string
  value: string
}

function PercentileCard({ label, value }: PercentileCardProps) {
  return (
    <div className="rounded-sm bg-gray-50 px-3 py-2 dark:bg-gray-700/50">
      <div className="text-xs text-gray-500 dark:text-gray-400">{label}</div>
      <div className="font-mono text-sm font-semibold text-gray-900 dark:text-gray-100">{value}</div>
    </div>
  )
}

interface PercentileCardsProps {
  title: string
  /** The figures, sorted ascending. */
  sorted: number[]
  format: (value: number) => string
}

/** The percentile grid of a distribution tab, from the fifth to the ninety-ninth. */
export function PercentileCards({ title, sorted, format }: PercentileCardsProps) {
  return (
    <div className="rounded-sm border border-gray-200 bg-white p-4 dark:border-gray-700 dark:bg-gray-800">
      <h4 className="mb-3 text-sm font-medium text-gray-900 dark:text-gray-100">
        {title}
      </h4>
      <div className="grid grid-cols-4 gap-3 sm:grid-cols-8">
        <PercentileCard label="P5" value={format(percentile(sorted, 5))} />
        <PercentileCard label="P10" value={format(percentile(sorted, 10))} />
        <PercentileCard label="P25" value={format(percentile(sorted, 25))} />
        <PercentileCard label="P50 (Median)" value={format(percentile(sorted, 50))} />
        <PercentileCard label="P75" value={format(percentile(sorted, 75))} />
        <PercentileCard label="P90" value={format(percentile(sorted, 90))} />
        <PercentileCard label="P95" value={format(percentile(sorted, 95))} />
        <PercentileCard label="P99" value={format(percentile(sorted, 99))} />
      </div>
    </div>
  )
}

interface CategorySummaryProps {
  title?: string
  groups: CategoryGroup[]
  format: (value: number) => string
}

/** The per category table of a distribution tab, absent where the data holds no category. */
export function CategorySummary({ title = 'Category Summary', groups, format }: CategorySummaryProps) {
  if (groups.length === 0) return null

  return (
    <div className="rounded-sm border border-gray-200 bg-white p-4 dark:border-gray-700 dark:bg-gray-800">
      <h4 className="mb-3 text-sm font-medium text-gray-900 dark:text-gray-100">
        {title}
      </h4>
      <div className="overflow-x-auto">
        <table className="min-w-full divide-y divide-gray-200 dark:divide-gray-700">
          <thead>
            <tr>
              <th className="px-3 py-2 text-left text-xs font-medium text-gray-700 dark:text-gray-300">
                Category
              </th>
              <th className="px-3 py-2 text-right text-xs font-medium text-gray-700 dark:text-gray-300">
                Count
              </th>
              <th className="px-3 py-2 text-right text-xs font-medium text-gray-700 dark:text-gray-300">
                Min
              </th>
              <th className="px-3 py-2 text-right text-xs font-medium text-gray-700 dark:text-gray-300">
                Median
              </th>
              <th className="px-3 py-2 text-right text-xs font-medium text-gray-700 dark:text-gray-300">
                Avg
              </th>
              <th className="px-3 py-2 text-right text-xs font-medium text-gray-700 dark:text-gray-300">
                Max
              </th>
            </tr>
          </thead>
          <tbody className="divide-y divide-gray-200 dark:divide-gray-700">
            {groups.map((cat) => (
              <tr key={cat.category}>
                <td className="px-3 py-2">
                  <div className="flex items-center gap-2">
                    <span
                      className="size-3 rounded-full"
                      style={{ backgroundColor: CATEGORY_COLORS[cat.category] }}
                    />
                    <span className="text-sm capitalize text-gray-900 dark:text-gray-100">
                      {cat.category}
                    </span>
                  </div>
                </td>
                <td className="px-3 py-2 text-right font-mono text-sm text-gray-600 dark:text-gray-400">
                  {cat.count}
                </td>
                <td className="px-3 py-2 text-right font-mono text-sm text-gray-600 dark:text-gray-400">
                  {format(cat.min)}
                </td>
                <td className="px-3 py-2 text-right font-mono text-sm text-gray-900 dark:text-gray-100">
                  {format(cat.median)}
                </td>
                <td className="px-3 py-2 text-right font-mono text-sm text-gray-600 dark:text-gray-400">
                  {format(cat.avg)}
                </td>
                <td className="px-3 py-2 text-right font-mono text-sm text-gray-600 dark:text-gray-400">
                  {format(cat.max)}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  )
}

export function DistributionTab({ data, stats, isDark, useLogScale }: DistributionTabProps) {
  const activeCategories = useMemo<TestCategory[]>(() =>
    ALL_CATEGORIES.filter(cat => (stats?.categoryBreakdown[cat] ?? 0) > 0),
    [stats]
  )

  const sorted = useMemo(() => [...data.map((d) => d.throughput)].sort((a, b) => a - b), [data])

  const categoryStats = useMemo(() => summariseByCategory(data, (d) => d.throughput), [data])

  if (data.length === 0 || !stats) {
    return (
      <div className="py-8 text-center text-sm text-gray-500 dark:text-gray-400">
        No data available for the current filters.
      </div>
    )
  }

  const throughput = (value: number) => value.toFixed(1)

  return (
    <div className="flex flex-col gap-6">
      <PercentileCards title="Throughput Percentiles (MGas/s)" sorted={sorted} format={throughput} />

      <CategorySummary groups={categoryStats} format={throughput} />

      {/* Charts */}
      <div className="flex flex-col gap-6">
        <div className="rounded-sm border border-gray-200 bg-white p-4 dark:border-gray-700 dark:bg-gray-800">
          <BoxPlotChart data={data} isDark={isDark} useLogScale={useLogScale} />
        </div>
        <div className="rounded-sm border border-gray-200 bg-white p-4 dark:border-gray-700 dark:bg-gray-800">
          <HistogramChart data={data} isDark={isDark} useLogScale={useLogScale} activeCategories={activeCategories} />
        </div>
      </div>
    </div>
  )
}

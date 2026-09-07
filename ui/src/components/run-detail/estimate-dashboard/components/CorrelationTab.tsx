import { useCallback, useMemo, useRef, useState } from 'react'
import { useNameDisplayMode, type NameDisplayMode } from '@/hooks/useNameDisplayMode'
import { formatTestNameLong } from '@/utils/eestName'
import {
  deviation,
  formatCost,
  formatPercent,
  formatRate,
  formatSignedDuration,
  formatSignedPercent,
  type CostPoint,
  type Fit,
} from '@/utils/estimate'
import { ChartSection, StatCard } from '../../RemoteMetricsPanel'
import { chartFrame } from '../../remoteMetricsChart'
import { CategorySummary, PercentileCards } from '../../block-logs-dashboard/components/DistributionTab'
import type { TestCategory } from '../../block-logs-dashboard/types'
import { parseCategory } from '../../block-logs-dashboard/utils/categoryParser'
import { ALL_CATEGORIES, CATEGORY_COLORS } from '../../block-logs-dashboard/utils/colors'
import { summariseByCategory } from '../../block-logs-dashboard/utils/statistics'
import type { EstimateRow } from '../types'

const categoryLabel = (category: TestCategory): string => category.charAt(0).toUpperCase() + category.slice(1)

interface CorrelationChartProps {
  title: string
  points: CostPoint[]
  fit: Fit
  isDark: boolean
  nameMode: NameDisplayMode
  zoomRange: { start: number; end: number }
  onZoom: (start: number, end: number) => void
  onTestClick?: (testName: string) => void
}

/** One point per test against the fitted line, the value axis holding a duration and the cost axis a price. */
function CorrelationChart({ title, points, fit, isDark, nameMode, zoomRange, onZoom, onTestClick }: CorrelationChartProps) {
  const highlightedTestRef = useRef<string | null>(null)

  // One series per category the run holds, so a point carries the hue the throughput scatter gives it.
  const categorised = useMemo(
    () =>
      ALL_CATEGORIES.flatMap((category) => {
        const held = points.filter((point) => parseCategory(point.testName) === category)
        return held.length === 0 ? [] : [{ category, held }]
      }),
    [points],
  )

  const option = useMemo(() => {
    const { textColor, mutedColor, base, legendStyle, tooltipStyle, xAxisStyle, yAxisStyle } = chartFrame(isDark, zoomRange, formatCost)
    const ends = [points[0].cost, points[points.length - 1].cost].map((cost) => [cost, fit.predicted(cost)])

    return {
      ...base,
      animation: false,
      // The frame tops the grid by a share of the height, which leaves a wide empty band on a 500px chart.
      grid: { ...base.grid, top: 30 },
      // Nothing is filtered out of the zoom window, so the fitted line still draws across both edges.
      dataZoom: base.dataZoom.map((zoom) => ({ ...zoom, filterMode: 'none' as const })),
      xAxis: xAxisStyle(formatCost),
      yAxis: { ...yAxisStyle(formatSignedDuration), min: 0 },
      legend: {
        ...legendStyle,
        type: 'scroll' as const,
        pageIconColor: textColor,
        pageIconInactiveColor: mutedColor,
        pageTextStyle: { color: textColor, fontSize: 10 },
        data: categorised.map(({ category }) => categoryLabel(category)),
      },
      tooltip: {
        ...tooltipStyle,
        trigger: 'item' as const,
        formatter: (params: { value: [number, number, string] }) => {
          const [cost, timeMs, testName] = params.value
          highlightedTestRef.current = testName
          const predicted = fit.predicted(cost)
          return [
            formatTestNameLong(testName, nameMode),
            `Estimated Cost: <strong>${formatCost(cost)}</strong>`,
            `Time: <strong>${formatSignedDuration(timeMs)}</strong>`,
            `Fitted: <strong>${formatSignedDuration(predicted)}</strong>`,
            `Error: <strong>${formatSignedPercent(deviation(timeMs, predicted))}</strong>`,
          ].join('<br/>')
        },
      },
      series: [
        ...categorised.map(({ category, held }) => ({
          name: categoryLabel(category),
          type: 'scatter' as const,
          symbolSize: 6,
          itemStyle: { color: CATEGORY_COLORS[category] },
          data: held.map((point) => [point.cost, point.timeMs, point.testName]),
        })),
        {
          type: 'line' as const,
          silent: true,
          symbol: 'none',
          data: ends,
          lineStyle: { type: 'dashed' as const, color: mutedColor, width: 1 },
          itemStyle: { color: mutedColor },
        },
      ],
    }
  }, [categorised, points, fit, isDark, zoomRange, nameMode])

  return (
    <ChartSection
      title={title}
      option={option}
      onZoom={onZoom}
      onPointClick={onTestClick}
      highlightedTestRef={highlightedTestRef}
      height="500px"
    />
  )
}

interface CorrelationTabProps {
  rows: EstimateRow[]
  fit: Fit | null
  /** Names the measured time, "Execution" or "Proving". */
  timeLabel: string
  isDark: boolean
  onTestClick?: (testName: string) => void
}

/** Plots the measured time of every timed test against its estimated cost, with the fitted line and its errors. */
export function CorrelationTab({ rows, fit, timeLabel, isDark, onTestClick }: CorrelationTabProps) {
  const { mode: nameMode } = useNameDisplayMode()
  const [zoomRange, setZoomRange] = useState({ start: 0, end: 100 })

  const onZoom = useCallback((start: number, end: number) => {
    setZoomRange({ start, end })
  }, [])

  const timed = useMemo(() => rows.filter((row) => row.error !== null), [rows])
  const points = useMemo(
    () => timed.map((row): CostPoint => ({ testName: row.testName, cost: row.total, timeMs: row.timeMs! })).sort((left, right) => left.cost - right.cost),
    [timed],
  )
  // The error reads unsigned here whatever the table prints, so a miss on either side of the line counts the same.
  const { errors, groups } = useMemo(() => {
    const error = (row: EstimateRow) => Math.abs(row.error!)

    return { errors: timed.map(error).sort((a, b) => a - b), groups: summariseByCategory(timed, error) }
  }, [timed])

  if (fit === null || points.length === 0) {
    return (
      <div className="py-8 text-center text-sm text-gray-500 dark:text-gray-400">
        No timed test for the current filters.
      </div>
    )
  }


  return (
    <div className="flex flex-col gap-6">
      <PercentileCards title="|Error| Percentiles" sorted={errors} format={formatPercent} />

      <CategorySummary title="Category Summary (|Error|)" groups={groups} format={formatPercent} />

      <div className="flex flex-col gap-4 rounded-sm border border-gray-200 bg-white p-4 dark:border-gray-700 dark:bg-gray-800">
        <div className="grid grid-cols-2 gap-2 sm:grid-cols-4 lg:grid-cols-8">
          <StatCard label="Slope" value={formatRate(fit.slope)} />
          <StatCard label="Intercept" value={formatSignedDuration(fit.intercept)} />
          <StatCard label="R^2" value={fit.determination.toFixed(3)} />
        </div>

        <CorrelationChart
          title={`${timeLabel} Time against Estimated Cost`}
          points={points}
          fit={fit}
          isDark={isDark}
          nameMode={nameMode}
          zoomRange={zoomRange}
          onZoom={onZoom}
          onTestClick={onTestClick}
        />
      </div>
    </div>
  )
}

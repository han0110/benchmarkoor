import { useEffect, useMemo, useRef, useState } from 'react'
import type { TestEntry } from '@/api/types'
import { formatTestNameLong } from '@/utils/eestName'
import { useNameDisplayMode } from '@/hooks/useNameDisplayMode'
import { getAggregatedStats, ALL_STEP_TYPES } from '@/pages/RunDetailPage'
import type { TestStatusFilter } from './TestsTable'

export function useDarkMode() {
  const [isDark, setIsDark] = useState(() => document.documentElement.classList.contains('dark'))

  useEffect(() => {
    const observer = new MutationObserver(() => {
      setIsDark(document.documentElement.classList.contains('dark'))
    })
    observer.observe(document.documentElement, { attributes: true, attributeFilter: ['class'] })
    return () => observer.disconnect()
  }, [])

  return isDark
}

/**
 * useStatusFilter turns the status filter of the page into a test predicate.
 * It is the rule the tests table and the resource charts apply, so every panel
 * plots the same population.
 */
export function useStatusFilter(tests?: Record<string, TestEntry>, statusFilter: TestStatusFilter = 'all') {
  return useMemo(() => {
    if (!tests || statusFilter === 'all') return undefined

    return (testName: string) => {
      const entry = tests[testName]
      const stats = entry ? getAggregatedStats(entry, ALL_STEP_TYPES) : undefined
      if (!stats) return false

      return statusFilter === 'passed' ? stats.fail === 0 : stats.fail !== 0
    }
  }, [tests, statusFilter])
}

/** A stat card figure, which reads n/a when no block measured it. */
export function figure(value: number | null, decimals: number): string {
  return value === null ? 'n/a' : value.toFixed(decimals)
}

/** The fields every remote metric point carries, which the axis and the tooltip read. */
export interface ChartPoint {
  testIndex: number
  testNumber: number
  testName: string
}

export interface Series<P> {
  name: string
  color: string
  value: (point: P) => number | null
}

/** A dashed line marking a hardware limit, so the gap below it reads as headroom. */
export interface Reference {
  value: number
  label: string
}

/** The one hue of every busiest series, so the eye learns it once across the panels. */
export const BUSIEST_COLOR = '#be185d'

/** The floor of a percent axis. An idle pipe then reads as a flat line at zero rather than as noise scaled to fill the chart. */
export const PERCENT_FLOOR = 1

interface ChartOptionBuilderArgs<P extends ChartPoint> {
  dataPoints: P[]
  isDark: boolean
  nameMode: ReturnType<typeof useNameDisplayMode>['mode']
  zoomRange: { start: number; end: number }
  /** One tooltip line naming how many devices the point rests on. Module scoped, so the options stay memoised. */
  describe: (point: P) => string
}

/**
 * useChartOptionBuilder returns the option factory the remote metric panels
 * share, and the ref that remembers the test under the pointer for a click to
 * open. Every chart plots one value per block on a shared zoom. Two or more
 * legend entries get a legend. A limit rides on a dashed series of its own,
 * named in the legend by its value, so hiding a data series never hides the
 * limit and no label crosses the data. A floor keeps a percent axis from
 * zooming into noise.
 */
export function useChartOptionBuilder<P extends ChartPoint>({ dataPoints, isDark, nameMode, zoomRange, describe }: ChartOptionBuilderArgs<P>) {
  const highlightedTestRef = useRef<string | null>(null)

  const makeOption = useMemo(() => {
    const textColor = isDark ? '#ffffff' : '#374151'
    const mutedColor = isDark ? '#9ca3af' : '#6b7280'
    const axisLineColor = isDark ? '#4b5563' : '#d1d5db'
    const splitLineColor = isDark ? '#374151' : '#e5e7eb'
    const isLargeDataset = dataPoints.length > 100

    const baseConfig = {
      backgroundColor: 'transparent',
      animation: !isLargeDataset,
      textStyle: { color: textColor },
      grid: { left: '3%', right: '4%', bottom: '50', top: '15%', containLabel: true },
      xAxis: {
        type: 'value' as const,
        min: 1,
        max: Math.max(dataPoints.length, 1),
        minInterval: 1,
        axisLabel: {
          color: textColor,
          fontSize: 11,
          formatter: (value: number) => `#${value}`,
        },
        axisLine: { show: true, lineStyle: { color: axisLineColor } },
        axisTick: { show: true, lineStyle: { color: axisLineColor } },
        splitLine: { show: false },
      },
      dataZoom: [
        {
          type: 'slider' as const,
          xAxisIndex: 0,
          start: zoomRange.start,
          end: zoomRange.end,
          height: 20,
          bottom: 5,
          borderColor: axisLineColor,
          fillerColor: isDark ? 'rgba(34, 197, 94, 0.3)' : 'rgba(34, 197, 94, 0.1)',
          backgroundColor: isDark ? '#374151' : '#f3f4f6',
          dataBackground: {
            lineStyle: { color: isDark ? '#6b7280' : '#9ca3af' },
            areaStyle: { color: isDark ? '#4b5563' : '#e5e7eb' },
          },
          selectedDataBackground: {
            lineStyle: { color: '#22c55e' },
            areaStyle: { color: isDark ? 'rgba(34, 197, 94, 0.3)' : 'rgba(34, 197, 94, 0.2)' },
          },
          textStyle: { color: textColor, fontSize: 10 },
          labelFormatter: (value: number) => `#${Math.round(value)}`,
        },
        { type: 'inside' as const, xAxisIndex: 0, start: zoomRange.start, end: zoomRange.end },
      ],
    }

    return (series: Series<P>[], format: (v: number) => string, limit?: Reference, floor?: number) => {
      const show = (value: number | null) => (value === null ? 'n/a' : format(value))
      // ECharts places a marker line at its value rounded to two decimals and
      // drops it when that lands above the axis top. The limit is rounded the
      // same way first, so the axis top and the marker share one value.
      const reference = limit === undefined ? undefined : { ...limit, value: Number(limit.value.toFixed(2)) }
      const referenceName = reference === undefined ? undefined : `${format(reference.value)} ${reference.label}`
      const legendNames = [...series.map((s) => s.name), ...(referenceName === undefined ? [] : [referenceName])]

      return {
        ...baseConfig,
        legend:
          legendNames.length > 1
            ? {
                data: legendNames,
                top: 0,
                right: 0,
                textStyle: { color: textColor, fontSize: 10 },
                itemWidth: 10,
                itemHeight: 8,
              }
            : undefined,
        tooltip: {
          trigger: 'axis' as const,
          axisPointer: { type: 'line' as const },
          backgroundColor: isDark ? '#1f2937' : '#ffffff',
          borderColor: isDark ? '#374151' : '#e5e7eb',
          textStyle: { color: textColor, fontSize: 12 },
          formatter: (params: Array<{ dataIndex: number }>) => {
            const point = dataPoints[params[0]?.dataIndex]
            if (!point) return ''
            highlightedTestRef.current = point.testName

            return [
              `<strong>Test #${point.testNumber}</strong>`,
              formatTestNameLong(point.testName, nameMode),
              ...series.map((s) => `${s.name}: <strong>${show(s.value(point))}</strong>`),
              describe(point),
            ].join('<br/>')
          },
        },
        yAxis: {
          type: 'value' as const,
          // A limit sets the top of the axis, so the room under it is the
          // headroom the rig had left. Without one the axis starts at zero.
          scale: reference !== undefined,
          max: reference
            ? (extent: { max: number }) => (Number.isFinite(extent.max) ? Math.max(extent.max, reference.value) : reference.value)
            : floor !== undefined
              ? (extent: { max: number }) => (extent.max < floor ? floor : undefined)
              : undefined,
          axisLabel: { color: textColor, fontSize: 11, formatter: (v: number) => format(v) },
          axisLine: { show: true, lineStyle: { color: axisLineColor } },
          splitLine: { show: true, lineStyle: { color: splitLineColor, type: 'dashed' as const } },
        },
        series: [
          ...series.map((s) => ({
            name: s.name,
            type: 'line' as const,
            smooth: false,
            symbol: isLargeDataset ? 'none' : 'circle',
            symbolSize: 4,
            sampling: 'lttb' as const,
            data: dataPoints.map((point) => [point.testIndex, s.value(point)]),
            lineStyle: { width: 1.5, color: s.color },
            itemStyle: { color: s.color },
          })),
          ...(reference
            ? [
                {
                  name: referenceName,
                  type: 'line' as const,
                  data: [] as Array<[number, number]>,
                  silent: true,
                  symbol: 'none',
                  lineStyle: { type: 'dashed' as const, color: mutedColor, width: 1 },
                  itemStyle: { color: mutedColor },
                  markLine: {
                    silent: true,
                    symbol: 'none',
                    lineStyle: { type: 'dashed' as const, color: mutedColor, width: 1 },
                    label: { show: false },
                    data: [{ yAxis: reference.value }],
                  },
                },
              ]
            : []),
        ],
      }
    }
  }, [dataPoints, isDark, nameMode, zoomRange, describe])

  return { makeOption, highlightedTestRef }
}

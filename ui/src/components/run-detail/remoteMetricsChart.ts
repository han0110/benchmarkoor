import { useEffect, useMemo, useRef, useState, type ReactNode } from 'react'
import type { DeviceMetrics, SuiteTest, TestEntry } from '@/api/types'
import type { TraceSeries } from '@/utils/testMetrics'
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
  /** Keeps zero on the axis, for a limit that is the whole scale of the chart. */
  wholeScale?: boolean
}

/** The artifact and the page filters one remote metric section reads. */
export interface RemoteMetricsSectionProps {
  metrics?: DeviceMetrics | null
  /** Suite tests in canonical run order, so Test # matches the other charts. */
  suiteTests?: SuiteTest[]
  /** Only tests whose name matches this query are charted. */
  searchQuery?: string
  /** Test results, which carry the pass or fail state the status filter reads. */
  tests?: Record<string, TestEntry>
  statusFilter?: TestStatusFilter
  onTestClick?: (testName: string) => void
  /** The zoom the panel owns, so one drag moves every chart of it. */
  zoomRange: ZoomRange
  onZoom: (start: number, end: number) => void
}

/** The parts of one exporter, which the panel lays out beside those of the others. */
export interface RemoteMetricsSection {
  source: { name: string; title: string }
  cards: ReactNode
  charts: ReactNode
}

/** The one hue of every busiest series, so the eye learns it once across the panels. */
export const BUSIEST_COLOR = '#be185d'

/** The floor of a percent axis. An idle pipe then reads as a flat line at zero rather than as noise scaled to fill the chart. */
export const PERCENT_FLOOR = 1

interface ZoomRange {
  start: number
  end: number
}

/** chartFrame returns the theme and layout every remote metric chart shares. */
export function chartFrame(isDark: boolean, zoomRange: ZoomRange, zoomLabel: (value: number) => string) {
  const textColor = isDark ? '#ffffff' : '#374151'
  const mutedColor = isDark ? '#9ca3af' : '#6b7280'
  const axisLineColor = isDark ? '#4b5563' : '#d1d5db'
  const splitLineColor = isDark ? '#374151' : '#e5e7eb'

  return {
    textColor,
    mutedColor,
    base: {
      backgroundColor: 'transparent',
      textStyle: { color: textColor },
      grid: { left: '3%', right: '4%', bottom: '50', top: '15%', containLabel: true },
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
          labelFormatter: zoomLabel,
        },
        { type: 'inside' as const, xAxisIndex: 0, start: zoomRange.start, end: zoomRange.end },
      ],
    },
    legendStyle: {
      top: 0,
      right: 0,
      textStyle: { color: textColor, fontSize: 10 },
      itemWidth: 10,
      itemHeight: 8,
    },
    tooltipStyle: {
      trigger: 'axis' as const,
      axisPointer: { type: 'line' as const },
      backgroundColor: isDark ? '#1f2937' : '#ffffff',
      borderColor: isDark ? '#374151' : '#e5e7eb',
      textStyle: { color: textColor, fontSize: 12 },
    },
    xAxisStyle: (label: (value: number) => string) => ({
      type: 'value' as const,
      axisLabel: { color: textColor, fontSize: 11, formatter: label },
      axisLine: { show: true, lineStyle: { color: axisLineColor } },
      axisTick: { show: true, lineStyle: { color: axisLineColor } },
      splitLine: { show: false },
    }),
    yAxisStyle: (format: (v: number) => string) => ({
      type: 'value' as const,
      axisLabel: { color: textColor, fontSize: 11, formatter: (v: number) => format(v) },
      axisLine: { show: true, lineStyle: { color: axisLineColor } },
      splitLine: { show: true, lineStyle: { color: splitLineColor, type: 'dashed' as const } },
    }),
  }
}

/**
 * referenceLine renders a limit as a dashed series of its own, named by its
 * value. ECharts places a marker line at its value rounded to two decimals and
 * drops it when that lands above the axis top, so the value is rounded the
 * same way first and the axis top and the marker share it.
 */
function referenceLine(limit: Reference, format: (v: number) => string, color: string) {
  const value = Number(limit.value.toFixed(2))
  const name = `${format(value)} ${limit.label}`
  const dashed = { type: 'dashed' as const, color, width: 1 }

  return {
    name,
    // A limit sets the top of the axis, so the room under it is the headroom
    // the rig had left. A limit that is the whole scale keeps zero on the axis.
    axis: {
      scale: !limit.wholeScale,
      max: (extent: { max: number }) => (Number.isFinite(extent.max) ? Math.max(extent.max, value) : value),
    },
    series: {
      name,
      type: 'line' as const,
      data: [] as Array<[number, number]>,
      silent: true,
      symbol: 'none',
      lineStyle: dashed,
      itemStyle: { color },
      markLine: {
        silent: true,
        symbol: 'none',
        lineStyle: dashed,
        label: { show: false },
        data: [{ yAxis: value }],
      },
    },
  }
}

/** A percent axis floor, which keeps an idle chart from zooming into noise. */
const floorMax = (floor?: number) => ({
  max: floor === undefined ? undefined : (extent: { max: number }) => (extent.max < floor ? floor : undefined),
})

interface ChartOptionBuilderArgs<P extends ChartPoint> {
  dataPoints: P[]
  isDark: boolean
  nameMode: ReturnType<typeof useNameDisplayMode>['mode']
  zoomRange: ZoomRange
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
    // The axis plots the dense index of the charted points, so the label
    // reads the test number the tooltip and the tests table name. Only an
    // integer position names a test. A zoom slider handle rests on a
    // fractional position, so it names the nearest test.
    const testLabel = (position: number) => {
      const point = Number.isInteger(position) ? dataPoints[position - 1] : undefined

      return point ? `#${point.testNumber}` : ''
    }
    const { mutedColor, base, legendStyle, tooltipStyle, xAxisStyle, yAxisStyle } = chartFrame(isDark, zoomRange, (value) => testLabel(Math.round(value)))
    const isLargeDataset = dataPoints.length > 100

    const baseConfig = {
      ...base,
      animation: !isLargeDataset,
      xAxis: {
        ...xAxisStyle(testLabel),
        min: 1,
        max: Math.max(dataPoints.length, 1),
        minInterval: 1,
      },
    }

    return (series: Series<P>[], format: (v: number) => string, limit?: Reference, floor?: number) => {
      const show = (value: number | null) => (value === null ? 'n/a' : format(value))
      const reference = limit === undefined ? undefined : referenceLine(limit, format, mutedColor)
      const legendNames = [...series.map((s) => s.name), ...(reference === undefined ? [] : [reference.name])]

      return {
        ...baseConfig,
        legend: legendNames.length > 1 ? { ...legendStyle, data: legendNames } : undefined,
        tooltip: {
          ...tooltipStyle,
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
          ...yAxisStyle(format),
          ...(reference === undefined ? floorMax(floor) : reference.axis),
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
          ...(reference === undefined ? [] : [reference.series]),
        ],
      }
    }
  }, [dataPoints, isDark, nameMode, zoomRange, describe])

  return { makeOption, highlightedTestRef }
}

/**
 * useTraceOptionBuilder returns the option factory of the per test trace
 * charts. Every chart plots one line per device over the seconds of the
 * proving window on a shared zoom. The legend lists every device and scrolls
 * once it holds more than eight, so any line can be toggled. The tooltip
 * lists the devices that refreshed at the instant under the pointer. A limit
 * rides on a dashed line of its own, as it does on the run charts.
 */
export function useTraceOptionBuilder({ isDark, zoomRange }: { isDark: boolean; zoomRange: ZoomRange }) {
  return useMemo(() => {
    const seconds = (value: number) => `${value.toFixed(1)} s`
    const { textColor, mutedColor, base, legendStyle, tooltipStyle, xAxisStyle, yAxisStyle } = chartFrame(isDark, zoomRange, seconds)

    return (series: TraceSeries[], format: (v: number) => string, floor?: number, limit?: Reference) => {
      const show = (value: number | null) => (value === null ? 'n/a' : format(value))
      const isLargeDataset = series.reduce((total, s) => total + s.data.length, 0) > 100
      const reference = limit === undefined ? undefined : referenceLine(limit, format, mutedColor)

      return {
        ...base,
        legend: {
          ...legendStyle,
          type: series.length > 8 ? ('scroll' as const) : ('plain' as const),
          pageIconColor: textColor,
          pageIconInactiveColor: mutedColor,
          pageTextStyle: { color: textColor, fontSize: 10 },
          data: [...series.map((s) => s.name), ...(reference === undefined ? [] : [reference.name])],
        },
        tooltip: {
          ...tooltipStyle,
          formatter: (params: Array<{ seriesName: string; marker: string; value: [number, number | null] }>) =>
            params.length === 0
              ? ''
              : [
                  `<strong>${seconds(params[0].value[0])}</strong>`,
                  ...params.map((p) => `${p.marker}${p.seriesName}: <strong>${show(p.value[1])}</strong>`),
                ].join('<br/>'),
        },
        xAxis: { ...xAxisStyle(seconds), min: 0, max: 'dataMax' as const },
        yAxis: {
          ...yAxisStyle(format),
          ...(reference === undefined ? floorMax(floor) : reference.axis),
        },
        series: [
          ...series.map((s) => ({
            name: s.name,
            type: 'line' as const,
            smooth: false,
            symbol: isLargeDataset ? 'none' : 'circle',
            symbolSize: 4,
            data: s.data,
            lineStyle: { width: 1.5, color: s.color },
            itemStyle: { color: s.color },
          })),
          ...(reference === undefined ? [] : [reference.series]),
        ],
      }
    }
  }, [isDark, zoomRange])
}

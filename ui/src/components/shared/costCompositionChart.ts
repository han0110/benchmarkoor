import { COMPARISON_COLORS } from '@/components/run-detail/block-logs-dashboard/utils/colors'
import { formatCost } from '@/utils/estimate'

interface CompositionBar {
  label: string
  /** One figure per kind, in the order the kinds are given. */
  components: number[]
}

/** Colour a cost kind stacks in, cycling where the kinds outnumber the palette. */
export const kindColor = (index: number): string => COMPARISON_COLORS[index % COMPARISON_COLORS.length]

/** Segments under this share of the longest bar carry no label, there being no room to print one. */
const LABEL_MIN_FRACTION = 0.08

/** Spacer series that carries the total of a bar, left out of the legend and the tooltip. */
const TOTAL_SERIES = 'total'

interface CompositionArgs {
  bars: CompositionBar[]
  kinds: string[]
  isDark: boolean
  /** Labels a segment with its share of the bar rather than with its cost. */
  shares: boolean
}

export function compositionOption({ bars, kinds, isDark, shares }: CompositionArgs) {
  const textColor = isDark ? '#ffffff' : '#374151'
  const axisLineColor = isDark ? '#4b5563' : '#d1d5db'
  const surfaceColor = isDark ? '#374151' : '#f9fafb'
  const totals = bars.map((bar) => bar.components.reduce((sum, value) => sum + value, 0))
  const peak = Math.max(...totals) || 1
  const cheapest = Math.min(...totals)

  const segmentLabel = (params: { value: number; dataIndex: number }) => {
    if (params.value / peak < LABEL_MIN_FRACTION) return ''
    if (!shares) return formatCost(params.value)
    return `${Math.round((params.value / (totals[params.dataIndex] || 1)) * 100)}%`
  }

  const totalLabel = (params: { dataIndex: number }) => {
    const total = totals[params.dataIndex]
    if (bars.length < 2) return formatCost(total)
    return `${formatCost(total)} / ${cheapest > 0 ? `${(total / cheapest).toFixed(2)}x` : '-'}`
  }

  return {
    backgroundColor: 'transparent',
    animation: false,
    textStyle: { color: textColor },
    legend: {
      top: 0,
      textStyle: { color: textColor, fontSize: 10 },
      itemWidth: 10,
      itemHeight: 8,
      data: kinds,
    },
    grid: { left: 8, right: 96, top: 30, bottom: 8, containLabel: true },
    tooltip: {
      trigger: 'axis' as const,
      axisPointer: { type: 'shadow' as const },
      appendToBody: true,
      backgroundColor: isDark ? '#1f2937' : '#ffffff',
      borderColor: isDark ? '#374151' : '#e5e7eb',
      textStyle: { color: textColor, fontSize: 12 },
      formatter: (params: Array<{ dataIndex: number; seriesName: string; marker: string; value: number }>) => {
        const kindPoints = params.filter((point) => point.seriesName !== TOTAL_SERIES)
        if (kindPoints.length === 0) return ''
        const total = totals[kindPoints[0].dataIndex] || 1
        return [
          `<strong>${bars[kindPoints[0].dataIndex].label}</strong>`,
          ...kindPoints.map(
            (point) =>
              `${point.marker}${point.seriesName}: <strong>${formatCost(point.value)}</strong> (${((point.value / total) * 100).toFixed(1)}%)`,
          ),
          `Total: <strong>${formatCost(total)}</strong>`,
        ].join('<br/>')
      },
    },
    xAxis: {
      type: 'value' as const,
      axisLabel: { color: textColor, fontSize: 11, formatter: formatCost },
      axisLine: { show: true, lineStyle: { color: axisLineColor } },
      splitLine: { show: false },
    },
    yAxis: {
      type: 'category' as const,
      inverse: true,
      data: bars.map((bar) => bar.label),
      axisLabel: { color: textColor, fontSize: 11 },
      axisLine: { show: true, lineStyle: { color: axisLineColor } },
      axisTick: { show: false },
    },
    series: [
      ...kinds.map((kind, index) => ({
        name: kind,
        type: 'bar' as const,
        stack: 'cost',
        barMaxWidth: 24,
        // The border takes the surface colour, which keeps neighbouring segments apart.
        itemStyle: { color: kindColor(index), borderColor: surfaceColor, borderWidth: 1 },
        label: { show: true, fontSize: 10, color: '#ffffff', formatter: segmentLabel },
        data: bars.map((bar) => bar.components[index]),
      })),
      // Zero-width spacer closing each stack, so the total prints past the end of the bar.
      // It draws unclipped, to reach the margin the grid reserves on the right.
      {
        name: TOTAL_SERIES,
        type: 'bar' as const,
        stack: 'cost',
        silent: true,
        clip: false,
        itemStyle: { color: 'transparent' },
        label: { show: true, position: 'right' as const, fontSize: 11, color: textColor, formatter: totalLabel },
        data: bars.map(() => 0),
      },
    ],
  }
}

interface CompositionDonutArgs {
  /** One figure per kind, in the order the kinds are given. */
  components: number[]
  kinds: string[]
  isDark: boolean
}

/** A single composition as a donut, in the style of the overhead donut of BlockLogDetails.tsx. */
export function compositionDonutOption({ components, kinds, isDark }: CompositionDonutArgs) {
  const textColor = isDark ? '#ffffff' : '#374151'

  return {
    tooltip: {
      trigger: 'item' as const,
      backgroundColor: isDark ? '#1f2937' : '#ffffff',
      borderColor: isDark ? '#374151' : '#e5e7eb',
      textStyle: { color: textColor },
      formatter: (params: { name: string; value: number; percent: number }) =>
        `${params.name}: ${formatCost(params.value)} (${params.percent.toFixed(1)}%)`,
    },
    legend: {
      orient: 'vertical' as const,
      right: 0,
      top: 'center',
      textStyle: { color: textColor, fontSize: 11 },
      itemWidth: 12,
      itemHeight: 8,
    },
    series: [
      {
        type: 'pie' as const,
        radius: ['50%', '70%'],
        center: ['35%', '50%'],
        avoidLabelOverlap: false,
        label: { show: false },
        labelLine: { show: false },
        data: kinds
          .map((kind, index) => ({ name: kind, value: components[index], itemStyle: { color: kindColor(index) } }))
          .filter((slice) => slice.value > 0),
        emphasis: {
          itemStyle: {
            shadowBlur: 10,
            shadowOffsetX: 0,
            shadowColor: 'rgba(0, 0, 0, 0.5)',
          },
        },
      },
    ],
  }
}

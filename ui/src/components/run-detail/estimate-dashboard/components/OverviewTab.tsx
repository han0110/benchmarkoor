import { useCallback, useMemo, useState } from 'react'
import { compositionDonutOption, kindColor } from '@/components/shared/costCompositionChart'
import { useNameDisplayMode } from '@/hooks/useNameDisplayMode'
import { formatBytes } from '@/utils/format'
import { formatCost, formatPercent } from '@/utils/estimate'
import { ChartSection, StatCard } from '../../RemoteMetricsPanel'
import { chartFrame, useChartOptionBuilder } from '../../remoteMetricsChart'
import type { EstimateRow } from '../types'

/** The composition donut carries no zoom slider, so no drag reaches the panel. */
const onCompositionZoom = () => {}

/** The hue the node metrics charts give memory. */
const HEAP_COLOR = '#f59e0b'

/** The heap the cost tooltip names, left out where the test reports none. */
const describeHeap = (row: EstimateRow) => (row.peakHeapBytes == null ? '' : `Peak Heap: ${formatBytes(row.peakHeapBytes)}`)

const describeCost = (row: EstimateRow) => `Estimated Cost: ${formatCost(row.total)}`

interface OverviewTabProps {
  rows: EstimateRow[]
  kinds: string[]
  isDark: boolean
  onTestClick?: (testName: string) => void
}

/** States what the price of a test is made of and how much heap the guest held. */
export function OverviewTab({ rows, kinds, isDark, onTestClick }: OverviewTabProps) {
  const { mode: nameMode } = useNameDisplayMode()
  const [zoomRange, setZoomRange] = useState({ start: 0, end: 100 })

  const onZoom = useCallback((start: number, end: number) => {
    setZoomRange({ start, end })
  }, [])

  /** The mean cost of one kind over the plotted tests, which both the donut and the table state. */
  const componentCosts = useMemo(
    () => kinds.map((_kind, at) => rows.reduce((sum, row) => sum + row.costs[at], 0) / rows.length),
    [kinds, rows],
  )
  const componentTotal = componentCosts.reduce((sum, value) => sum + value, 0)

  const composition = useMemo(
    () => compositionDonutOption({ components: componentCosts, kinds, isDark }),
    [componentCosts, kinds, isDark],
  )

  const { makeOption: makeCostOption, highlightedTestRef: costHighlight } = useChartOptionBuilder<EstimateRow>({ dataPoints: rows, isDark, nameMode, zoomRange, describe: describeHeap })
  const { makeOption: makeHeapOption, highlightedTestRef: heapHighlight } = useChartOptionBuilder<EstimateRow>({ dataPoints: rows, isDark, nameMode, zoomRange, describe: describeCost })

  const costOption = useMemo(() => {
    // The total takes the muted hue the correlation line takes, leaving the palette to the kinds.
    const { mutedColor } = chartFrame(isDark, zoomRange, formatCost)
    return makeCostOption(
      [
        { name: 'Total', color: mutedColor, value: (row) => row.total },
        ...kinds.map((kind, at) => ({ name: kind, color: kindColor(at), value: (row: EstimateRow) => row.costs[at] })),
      ],
      formatCost,
    )
  }, [makeCostOption, kinds, isDark, zoomRange])

  const heapOption = useMemo(
    () => makeHeapOption([{ name: 'Peak Heap', color: HEAP_COLOR, value: (row) => row.peakHeapBytes }], formatBytes),
    [makeHeapOption],
  )

  const heaps = useMemo(() => rows.flatMap((row) => (row.peakHeapBytes == null ? [] : [row.peakHeapBytes])), [rows])

  if (rows.length === 0) {
    return (
      <div className="py-8 text-center text-sm text-gray-500 dark:text-gray-400">
        No data available for the current filters.
      </div>
    )
  }

  return (
    <div className="flex flex-col gap-4">
      {heaps.length > 0 && (
        <div className="grid grid-cols-2 gap-2 sm:grid-cols-4 lg:grid-cols-8">
          <StatCard label="Peak Heap (max)" value={formatBytes(Math.max(...heaps))} />
          <StatCard label="Peak Heap (mean)" value={formatBytes(heaps.reduce((sum, value) => sum + value, 0) / heaps.length)} />
        </div>
      )}

      <div className="grid grid-cols-1 gap-4 lg:grid-cols-2">
        <ChartSection title="Estimated Cost Composition" option={composition} onZoom={onCompositionZoom} />

        <div className="rounded-xs bg-gray-50 p-3 dark:bg-gray-700/50">
          <h4 className="mb-2 text-xs font-medium text-gray-700 dark:text-gray-300">Estimated Cost Components</h4>
          <table className="min-w-full divide-y divide-gray-200 dark:divide-gray-700">
            <thead>
              <tr>
                <th className="px-3 py-1.5 text-left text-xs/5 font-medium uppercase tracking-wider text-gray-500 dark:text-gray-400">Component</th>
                <th className="px-3 py-1.5 text-right text-xs/5 font-medium uppercase tracking-wider text-gray-500 dark:text-gray-400">Estimated Cost</th>
                <th className="px-3 py-1.5 text-right text-xs/5 font-medium uppercase tracking-wider text-gray-500 dark:text-gray-400">Share</th>
              </tr>
            </thead>
            <tbody>
              {kinds.map((kind, at) => (
                <tr key={kind}>
                  <td className="whitespace-nowrap px-3 py-1.5 text-sm/6 text-gray-700 dark:text-gray-300">
                    <span className="flex items-center gap-2">
                      <span className="size-2 rounded-full" style={{ backgroundColor: kindColor(at) }} />
                      {kind}
                    </span>
                  </td>
                  <td className="whitespace-nowrap px-3 py-1.5 text-right text-sm/6 text-gray-900 dark:text-gray-100">{formatCost(componentCosts[at])}</td>
                  <td className="whitespace-nowrap px-3 py-1.5 text-right text-sm/6 text-gray-500 dark:text-gray-400">{formatPercent(componentCosts[at] / (componentTotal || 1))}</td>
                </tr>
              ))}
              <tr className="border-t-2 border-gray-300 dark:border-gray-600">
                <td className="whitespace-nowrap px-3 py-1.5 text-sm/6 font-semibold text-gray-900 dark:text-gray-100">Total</td>
                <td className="whitespace-nowrap px-3 py-1.5 text-right text-sm/6 font-semibold text-gray-900 dark:text-gray-100">{formatCost(componentTotal)}</td>
                <td className="whitespace-nowrap px-3 py-1.5 text-right text-sm/6 font-semibold text-gray-900 dark:text-gray-100">{formatPercent(1)}</td>
              </tr>
            </tbody>
          </table>
        </div>

        <ChartSection title="Estimated Cost per Test" option={costOption} onZoom={onZoom} onPointClick={onTestClick} highlightedTestRef={costHighlight} />
        {heaps.length > 0 && (
          <ChartSection title="Peak Heap per Test" option={heapOption} onZoom={onZoom} onPointClick={onTestClick} highlightedTestRef={heapHighlight} />
        )}
      </div>
    </div>
  )
}

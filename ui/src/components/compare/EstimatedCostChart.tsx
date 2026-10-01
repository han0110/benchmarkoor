import { useCallback, useMemo, useState } from 'react'
import { BarChart2 } from 'lucide-react'
import { ChartSection } from '@/components/run-detail/RemoteMetricsPanel'
import { useChartOptionBuilder, useDarkMode } from '@/components/run-detail/remoteMetricsChart'
import { useNameDisplayMode } from '@/hooks/useNameDisplayMode'
import { RUN_SLOTS, formatRunLabel, type CompareRun, type LabelMode } from './constants'
import { COMPARED_VALUES, type ComparedTest, type ComparedValue } from './estimateComparison'

interface EstimatedCostChartProps {
  runs: CompareRun[]
  /** The passed and failed tests the filter keeps, in suite order. */
  rows: ComparedTest[]
  comparedValue: ComparedValue
  labelMode: LabelMode
}

/** A row at its position on the axis. */
type ChartRow = ComparedTest & { testIndex: number }

/** The tooltip names each estimate, so it gets no further line. Module scoped, so the options stay memoised. */
const describeNothing = () => ''

/** The figure of every estimate on each test, one line per estimate with a gap where the estimate has no figure. */
export function EstimatedCostChart({ runs, rows, comparedValue, labelMode }: EstimatedCostChartProps) {
  const isDark = useDarkMode()
  const { mode: nameMode } = useNameDisplayMode()
  const [zoomRange, setZoomRange] = useState({ start: 0, end: 100 })
  const { label, format } = COMPARED_VALUES[comparedValue]

  const onZoom = useCallback((start: number, end: number) => {
    setZoomRange({ start, end })
  }, [])

  const points = useMemo(() => rows.map((row, at): ChartRow => ({ ...row, testIndex: at + 1 })), [rows])
  const { makeOption } = useChartOptionBuilder<ChartRow>({ dataPoints: points, isDark, nameMode, zoomRange, describe: describeNothing })

  const option = useMemo(
    () =>
      makeOption(
        runs.map((run, at) => ({
          name: formatRunLabel(RUN_SLOTS[run.index], run, labelMode),
          color: RUN_SLOTS[run.index].color,
          value: (point: ChartRow) => point.values[at],
        })),
        format,
      ),
    [makeOption, runs, labelMode, format],
  )

  if (!rows.some((row) => row.values.some((value) => value !== null))) return null

  return (
    <div className="overflow-hidden rounded-sm bg-white shadow-xs dark:bg-gray-800">
      <div className="flex flex-wrap items-center gap-2 border-b border-gray-200 px-4 py-3 dark:border-gray-700">
        <BarChart2 className="size-4 text-gray-400 dark:text-gray-500" />
        <h3 className="text-sm/6 font-medium text-gray-900 dark:text-gray-100">{label} per Test</h3>
      </div>
      <div className="p-4">
        <ChartSection option={option} onZoom={onZoom} height="300px" />
      </div>
    </div>
  )
}

import { useCallback, useMemo, useRef, type ReactNode } from 'react'
import clsx from 'clsx'
import ReactECharts from 'echarts-for-react'
import { Cpu } from 'lucide-react'

interface StatCardProps {
  label: string
  value: string
}

export function StatCard({ label, value }: StatCardProps) {
  return (
    <div className="rounded-xs bg-gray-50 px-3 py-2 dark:bg-gray-700/50">
      <div className="text-xs text-gray-500 dark:text-gray-400">{label}</div>
      <div className="text-sm/6 font-medium text-gray-900 dark:text-gray-100">{value}</div>
    </div>
  )
}

interface ChartSectionProps {
  title: string
  option: object
  onZoom: (start: number, end: number) => void
  onPointClick?: (testName: string) => void
  highlightedTestRef?: React.MutableRefObject<string | null>
}

export function ChartSection({ title, option, onZoom, onPointClick, highlightedTestRef }: ChartSectionProps) {
  const mouseDownPos = useRef<{ x: number; y: number } | null>(null)

  const onEvents = useMemo(
    () => ({
      datazoom: (params: { start?: number; end?: number; batch?: Array<{ start: number; end: number }> }) => {
        if (params.batch && params.batch.length > 0) {
          onZoom(params.batch[0].start, params.batch[0].end)
        } else if (params.start !== undefined && params.end !== undefined) {
          onZoom(params.start, params.end)
        }
      },
    }),
    [onZoom],
  )

  const handleMouseDown = useCallback((e: React.MouseEvent) => {
    mouseDownPos.current = { x: e.clientX, y: e.clientY }
  }, [])

  const handleClick = useCallback(
    (e: React.MouseEvent) => {
      if (mouseDownPos.current) {
        const dx = Math.abs(e.clientX - mouseDownPos.current.x)
        const dy = Math.abs(e.clientY - mouseDownPos.current.y)
        if (dx > 5 || dy > 5) {
          return
        }
      }
      if (onPointClick && highlightedTestRef?.current) {
        onPointClick(highlightedTestRef.current)
      }
    },
    [onPointClick, highlightedTestRef],
  )

  return (
    <div className="rounded-xs bg-gray-50 p-3 dark:bg-gray-700/50">
      <h4 className="mb-2 text-xs font-medium text-gray-700 dark:text-gray-300">{title}</h4>
      <div
        onMouseDown={handleMouseDown}
        onClick={handleClick}
        style={{ cursor: onPointClick ? 'pointer' : 'default' }}
      >
        <ReactECharts
          option={option}
          style={{ height: '200px', width: '100%' }}
          opts={{ renderer: 'svg' }}
          onEvents={onEvents}
        />
      </div>
    </div>
  )
}

interface RemoteMetricsPanelProps {
  /** Heading of the panel, left out where the frame around it already names it. */
  title?: string
  /** The exporters the rows came from, each shown in the header with its own hint. */
  sources: Array<{ name: string; title: string }>
  cards: ReactNode
  charts: ReactNode
  footer: string
  /** Drops the card surface, for a panel that sits inside another one. */
  embedded?: boolean
}

export function RemoteMetricsPanel({ title, sources, cards, charts, footer, embedded = false }: RemoteMetricsPanelProps) {
  return (
    <div className={clsx('flex flex-col gap-4', !embedded && 'overflow-hidden rounded-sm bg-white p-4 shadow-xs dark:bg-gray-800')}>
      <div className="flex items-center">
        {title && (
          <h3 className="flex items-center gap-2 text-sm/6 font-medium text-gray-900 dark:text-gray-100">
            <Cpu className="size-4 text-gray-400 dark:text-gray-500" />
            {title}
          </h3>
        )}
        <span className="ml-auto flex flex-wrap items-center gap-1.5 text-xs/5 text-gray-500 dark:text-gray-400">
          Collection via
          {sources.map((source) => (
            <span key={source.name} className="cursor-help rounded-xs bg-gray-100 px-1.5 py-0.5 text-gray-600 dark:bg-gray-700 dark:text-gray-300" title={source.title}>
              {source.name}
            </span>
          ))}
        </span>
      </div>

      {/* Summary Stats Row */}
      <div className="grid grid-cols-4 gap-2 sm:grid-cols-6">{cards}</div>

      {/* Charts Grid */}
      <div className="grid grid-cols-1 gap-4 lg:grid-cols-2">{charts}</div>

      <p className="text-center text-xs/5 text-gray-500 dark:text-gray-400">{footer}</p>
    </div>
  )
}

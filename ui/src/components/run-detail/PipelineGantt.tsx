import { useMemo, useRef, useState } from 'react'
import ReactECharts from 'echarts-for-react'
import type { CustomSeriesRenderItemAPI, CustomSeriesRenderItemParams, CustomSeriesRenderItemReturn } from 'echarts'
import { breakdownRows, itemTitle, packRows, rowPitch, type PipelineItem } from '@/utils/pipeline'
import { chartFrame, useDarkMode } from './remoteMetricsChart'

/** Width of the worker color gutter hugging the left edge of the plot. */
const GUTTER = 8

/** Insets both charts share. No label moves them, so the ticks stand over the bars. */
const PLOT_LEFT = GUTTER + 6
const PLOT_RIGHT = 16

const BAND_MAX_HEIGHT = 480

/** Wash over the row under the pointer, gutter included, on either theme. */
const ROW_HIGHLIGHT = { light: 'rgba(0, 0, 0, 0.08)', dark: 'rgba(255, 255, 255, 0.12)' }

const seconds = (value: number) => `${value.toFixed(3)} s`
const axisSeconds = (value: number) => `${+value.toFixed(3)} s`

const dot = (color: string) => `<span style="display:inline-block;width:8px;height:8px;border-radius:50%;background:${color};margin-right:6px"></span>`
const cell = (text: string, pad: number) => `<td style="text-align:right;padding-left:${pad}px;white-space:nowrap">${text}</td>`

interface PipelineGanttProps {
  items: PipelineItem[]
  /** End of the whole proof, so the axis holds while the worker filter changes. */
  endSec: number
  /** The breakdown labels of the artifact, indexed by the pairs of an item. */
  breakdown: string[]
  workerColors: Record<string, string>
}

/**
 * PipelineGantt draws the tasks as a waterfall. The strip carries the time axis
 * and the zoom slider, and the band under it holds one thin row per task inside
 * a scrolling container. Both charts read the same zoom window. The gutter cell
 * of a row names the row and its worker, and every bar names its own task.
 */
export function PipelineGantt({ items, endSec, breakdown, workerColors }: PipelineGanttProps) {
  const isDark = useDarkMode()
  const [zoom, setZoom] = useState({ start: 0, end: 100 })
  const [hoverRow, setHoverRow] = useState<number | null>(null)
  const bandRef = useRef<HTMLDivElement>(null)

  const rows = useMemo(() => packRows(items), [items])
  const { pitch, bar } = rowPitch(rows.length)
  // One draw entry per bar, so every bar answers the pointer with its own task,
  // and one per row for its gutter cell, keyed by a negative bar index.
  const bars = useMemo(() => rows.flatMap((row, index) => row.items.map((item) => ({ row: index, item }))), [rows])
  // The bars of a row draw longest first, so a bar another bar covers lands on
  // top of it and answers the pointer.
  const entries = useMemo(() => {
    const span = (index: number) => bars[index].item.endSec - bars[index].item.startSec
    const drawn = bars.map((entry, index) => [entry.row, index]).sort((a, b) => a[0] - b[0] || span(b[1]) - span(a[1]))

    return [...rows.map((_, index) => [index, -1]), ...drawn]
  }, [bars, rows])

  const onEvents = useMemo(
    () => ({
      datazoom: (params: { start?: number; end?: number; batch?: Array<{ start: number; end: number }> }) => {
        const range = params.batch?.[0] ?? params
        if (range.start !== undefined && range.end !== undefined) {
          setZoom({ start: range.start, end: range.end })
        }
      },
    }),
    [],
  )

  const { base, xAxisStyle, tooltipStyle } = useMemo(() => chartFrame(isDark, zoom, axisSeconds), [isDark, zoom])

  const stripOption = useMemo(() => {
    const axis = xAxisStyle(axisSeconds)

    return {
      animation: false,
      backgroundColor: 'transparent',
      grid: { left: PLOT_LEFT, right: PLOT_RIGHT, top: 24, bottom: 22, outerBoundsMode: 'none' as const },
      xAxis: {
        ...axis,
        // The end labels draw inside the plot and drop the tick they meet, so
        // the total always reads and the axis keeps the inset of the band.
        axisLabel: { ...axis.axisLabel, showMaxLabel: true, alignMinLabel: 'left' as const, alignMaxLabel: 'right' as const },
        position: 'top' as const,
        min: 0,
        max: endSec,
      },
      yAxis: { type: 'value' as const, show: false },
      dataZoom: [{ ...base.dataZoom[0], height: 16, bottom: 4 }],
      series: [],
    }
  }, [base, endSec, xAxisStyle])

  const bandOption = useMemo(() => {
    const renderItem = (params: CustomSeriesRenderItemParams, api: CustomSeriesRenderItemAPI): CustomSeriesRenderItemReturn => {
      const row = api.value(0) as number
      const index = api.value(1) as number
      const plot = params.coordSys as unknown as { x: number; width: number }
      const top = api.coord([0, row])[1]
      const pitchPx = (api.size!([0, 1]) as number[])[1]
      if (index < 0) {
        const fill = workerColors[rows[row].items[0].workerName]

        return { type: 'rect', shape: { x: plot.x - GUTTER, y: top, width: GUTTER, height: pitchPx }, style: { fill } }
      }
      const { item } = bars[index]
      const clamp = (x: number) => Math.min(Math.max(x, plot.x), plot.x + plot.width)
      const left = api.coord([item.startSec, row])[0]
      const right = api.coord([item.endSec, row])[0]
      // A bar thinner than a pixel still has to be visible and hoverable.
      const x0 = clamp(left)
      const x1 = clamp(Math.max(right, left + 1))
      // A bar the window leaves out draws no element, which drops the element
      // the window before it drew.
      if (x1 <= x0) return undefined

      return {
        type: 'group',
        children: [
          {
            type: 'rect',
            shape: { x: x0, y: top + (pitchPx - bar) / 2, width: x1 - x0, height: bar },
            style: { fill: item.color },
          },
          { type: 'rect', shape: { x: x0, y: top, width: x1 - x0, height: pitchPx }, style: { fill: 'rgba(0,0,0,0)' } },
        ],
      } as CustomSeriesRenderItemReturn
    }

    return {
      animation: false,
      backgroundColor: 'transparent',
      grid: { left: PLOT_LEFT, right: PLOT_RIGHT, top: 0, bottom: 0, outerBoundsMode: 'none' as const },
      xAxis: { type: 'value' as const, show: false, min: (endSec * zoom.start) / 100, max: (endSec * zoom.end) / 100 },
      yAxis: { type: 'value' as const, inverse: true, show: false, min: 0, max: rows.length },
      tooltip: {
        ...tooltipStyle,
        trigger: 'item' as const,
        // A box taller than the scroll container is cut off inside it, so the
        // body carries it. Its position stays in canvas coordinates, and the
        // clamp holds it in the window through where the canvas sits.
        appendToBody: true,
        position: (point: number[], _params: unknown, dom: HTMLElement, _rect: unknown, size: { viewSize: number[] }) => {
          const band = bandRef.current
          const canvasTop = (band?.getBoundingClientRect().top ?? 0) - (band?.scrollTop ?? 0)
          const clamp = (value: number, low: number, high: number) => Math.min(Math.max(value, low), high)

          return [
            clamp(point[0] + 16, 0, size.viewSize[0] - dom.offsetWidth),
            clamp(point[1] + 16, 8 - canvasTop, window.innerHeight - dom.offsetHeight - 8 - canvasTop),
          ]
        },
        formatter: (params: { value: [number, number] }) => {
          const [row, index] = params.value
          const worker = (item: PipelineItem) => `${dot(workerColors[item.workerName])}${item.workerName} on ${item.nodeName}`
          if (index < 0) return `<b>${rows[row].title}</b><br/>${worker(rows[row].items[0])}`
          const { item } = bars[index]
          // The last row of the table is the Total, which needs no share.
          const table = breakdownRows(item, breakdown)
            .map((line, index, all) => `<tr><td>${line.label}</td>${cell(seconds(line.seconds), 12)}${cell(index === all.length - 1 ? '' : `${Math.round(line.share * 100)}%`, 10)}</tr>`)
            .join('')

          return (
            `<b>${itemTitle(item)}</b><br/>${worker(item)}<br/>` +
            `${seconds(item.startSec)} - ${seconds(item.endSec)} (${seconds(item.endSec - item.startSec)})` +
            (table === '' ? '' : `<table style="border-collapse:collapse;margin-top:3px">${table}</table>`)
          )
        },
      },
      series: [{ type: 'custom' as const, data: entries, renderItem }],
    }
  }, [bar, bars, breakdown, endSec, entries, rows, tooltipStyle, workerColors, zoom])

  return (
    <div className="flex flex-col">
      <ReactECharts option={stripOption} style={{ height: '48px', width: '100%' }} opts={{ renderer: 'svg' }} onEvents={onEvents} />
      <div ref={bandRef} className="overflow-y-auto" style={{ maxHeight: BAND_MAX_HEIGHT }}>
        <div
          className="relative"
          onMouseMove={(event) => setHoverRow(Math.min(Math.floor((event.clientY - event.currentTarget.getBoundingClientRect().top) / pitch), rows.length - 1))}
          onMouseLeave={() => setHoverRow(null)}
        >
          <ReactECharts option={bandOption} style={{ height: `${Math.max(rows.length, 1) * pitch}px`, width: '100%' }} opts={{ renderer: 'svg' }} />
          {hoverRow !== null && (
            <div
              className="pointer-events-none absolute inset-x-0"
              style={{ top: hoverRow * pitch, height: pitch, background: isDark ? ROW_HIGHLIGHT.dark : ROW_HIGHLIGHT.light }}
            />
          )}
        </div>
      </div>
    </div>
  )
}

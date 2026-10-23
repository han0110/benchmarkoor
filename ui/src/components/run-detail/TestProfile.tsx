import { Fragment, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react'
import { flushSync } from 'react-dom'
import clsx from 'clsx'
import ReactECharts from 'echarts-for-react'
import { color, format, type CustomSeriesRenderItemAPI, type CustomSeriesRenderItemParams, type CustomSeriesRenderItemReturn, type EChartsType } from 'echarts'
import { ChevronDown, ChevronUp } from 'lucide-react'
import { useTestProfile } from '@/api/hooks/useProfile'
import { SegmentedControl } from '@/components/shared/SegmentedControl'
import { CopyButton } from '@/components/shared/TestName'
import { formatCost, sortNullsLast } from '@/utils/estimate'
import { formatBytes, formatNumber } from '@/utils/format'
import { fnvHash, layoutFlame, matchedTotal, pathTo, sandwichOf, similarToParent, type CallNode, type Profile, type SampleType } from '@/utils/pprof'
import { SortHeader } from './block-logs-dashboard/components/BlockLogsTable'
import type { SortOrder } from './block-logs-dashboard/types'
import { StatCard } from './RemoteMetricsPanel'
import { chartFrame, useDarkMode } from './remoteMetricsChart'

const ROW_HEIGHT = 18

/** Functions the table lists until Show all. */
const TOP_FUNCTIONS = 25

/** A share column sorts as its value column but has a field of its own, so that only the clicked header shows as active. */
type FunctionSortField = 'function' | 'self' | 'selfShare' | 'total' | 'totalShare'

/** In Zoom mode, a click on a frame zooms into the frame. A click on a row of the functions table searches for its function, and a second click clears the search. In Sandwich mode, both show the callers and callees of the function. */
type ClickMode = 'zoom' | 'sandwich'

const CLICK_MODES: { value: ClickMode; label: string }[] = [
  { value: 'zoom', label: 'Zoom' },
  { value: 'sandwich', label: 'Sandwich' },
]

/** Whether the full flamegraph draws each group of similar frames as one row. */
type SimilarFrames = 'collapse' | 'expand'

const SIMILAR_FRAMES: { value: SimilarFrames; label: string }[] = [
  { value: 'collapse', label: 'Collapse' },
  { value: 'expand', label: 'Expand' },
]

const FONT_FAMILY = 'ui-monospace, SFMono-Regular, Menlo, monospace'
const FONT = `11px ${FONT_FAMILY}`

/** Name of the root frame, which holds every sample. */
const ROOT_NAME = 'all frames'

/** chartFrame takes a zoom range, and the flamegraph always shows the full range. */
const FULL_RANGE = { start: 0, end: 100 }

/** The hot palette of flamegraph.pl and inferno, from red through orange to yellow, in the warm colors of the performance heatmap. */
const HOT_COLORS = ['#ef4444', '#f97316', '#eab308']

/** The fill of the frames of a name, which the hash of the name places on HOT_COLORS. */
const hotFill = (name: string) => color.lerp(fnvHash(name), HOT_COLORS)

const ROOT_FILL = hotFill(ROOT_NAME)

// A frame label takes dark ink, as the labels of a classic flame graph are black.
const DARK_INK = '#111827'

/** The share of part in whole, with two decimals below 10%, so that a small frame does not read as zero. */
function formatShare(part: number, whole: number): string {
  const share = whole > 0 ? (100 * part) / whole : 0
  return `${share >= 10 ? share.toFixed(1) : share.toFixed(2)}%`
}

/** A value of the sample type with its unit. */
function formatValue(type: SampleType, value: number): string {
  if (type.kind === 'heap') return formatBytes(value)
  if (type.kind === 'calls') return `${formatCost(value)} ${value === 1 ? 'call' : 'calls'}`
  return `${formatCost(value)} ${type.unit}`
}

/** The name of the sample type in running text. */
const typeLabel = (type: SampleType) => (type.kind === 'heap' ? 'heap growth' : type.name)

interface FlameGraphProps {
  profile: Profile
  /** The tree to draw, by default the call tree of the profile. */
  nodes?: CallNode[]
  /** Draws node 0 at the bottom, for a tree whose children are callers. */
  rootAtBottom?: boolean
  /** Draws each group of similar frames as one row. */
  collapsed?: boolean
  type: number
  zoom: number
  /** Whether each function matches the highlight, null where nothing is highlighted. */
  matched: boolean[] | null
  clickMode: ClickMode
  onZoom: (node: number) => void
  onSandwich: (fn: number) => void
}

/**
 * A flamegraph with the root on top, or at the bottom for callers. A hover
 * names the frame. A click zooms into the frame in Zoom mode, and in Sandwich
 * mode shows the callers and callees of its function, except on node 0.
 */
function FlameGraph({ profile, nodes = profile.nodes, rootAtBottom = false, collapsed = false, type, zoom, matched, clickMode, onZoom, onSandwich }: FlameGraphProps) {
  const containerRef = useRef<HTMLDivElement>(null)
  const chartRef = useRef<ReactECharts>(null)
  const isDark = useDarkMode()
  const [width, setWidth] = useState(0)
  const fills = useMemo(() => profile.names.map(hotFill), [profile])
  const similar = useMemo(() => similarToParent(nodes, type), [nodes, type])
  const layout = useMemo(() => layoutFlame(nodes, type, zoom, width, similar, collapsed), [nodes, type, zoom, width, similar, collapsed])
  // echarts-for-react 3.0.5 does not unbind the old handlers when onEvents changes.
  // Thus onEvents does not change, and its click handler reads the props of the last render here.
  const latestProps = useRef({ clickMode, onZoom, onSandwich })

  useEffect(() => {
    const container = containerRef.current!
    const observer = new ResizeObserver(() => setWidth(container.clientWidth))
    observer.observe(container)
    return () => observer.disconnect()
  }, [])

  useEffect(() => {
    latestProps.current = { clickMode, onZoom, onSandwich }
  })

  // The callers show the function in the bottom row, so their container scrolls to the bottom after each layout.
  useLayoutEffect(() => {
    if (rootAtBottom) containerRef.current!.scrollTop = containerRef.current!.scrollHeight
  }, [rootAtBottom, layout])

  // The full graph shows the root row first after the callers.
  useLayoutEffect(() => {
    if (!rootAtBottom) containerRef.current!.scrollTop = 0
  }, [rootAtBottom])

  const sampleType = profile.types[type]
  const whole = profile.nodes[0].total[type]
  const inSandwich = nodes !== profile.nodes

  // A zoom that changes the rows resizes the chart, and zrender then forgets the
  // hovered frame but keeps its outline. Thus a click or a pointer exit from the
  // chart clears all outlines.
  const onEvents = useMemo(
    () => ({
      click: ({ value: [, , node, fn] }: { value: number[] }, chart: EChartsType) => {
        chart.dispatchAction({ type: 'downplay' })
        const latest = latestProps.current
        if (latest.clickMode === 'zoom') latest.onZoom(node)
        else if (node > 0) latest.onSandwich(fn)
      },
      globalout: (_params: unknown, chart: EChartsType) => chart.dispatchAction({ type: 'downplay' }),
    }),
    [],
  )

  const option = useMemo(() => {
    const { mutedColor, tooltipStyle } = chartFrame(isDark, FULL_RANGE, String)
    const tableCell = (text: string) => `<td style="padding-left:12px;text-align:right">${format.encodeHTML(text)}</td>`
    const tableRow = (label: string, value: string, share: string) => `<tr><td style="color:${mutedColor}">${label}</td>${tableCell(value)}${tableCell(share)}</tr>`

    // The series follows the ECharts flame graph example
    // (https://echarts.apache.org/examples/en/editor.html?c=flame-graph). Unlike the
    // example, it puts the root on top except for callers, and layoutFlame sets the
    // rows. The labels use DARK_INK and FONT, and the frames do not animate.
    const renderItem = (params: CustomSeriesRenderItemParams, api: CustomSeriesRenderItemAPI): CustomSeriesRenderItemReturn => {
      const rect = layout.rects[params.dataIndex]
      const { fn } = nodes[rect.node]
      // A collapsed row matches when one of its frames matches.
      const opacity = rect.ancestor ? 0.55 : matched && !rect.chain.some((node) => nodes[node].fn >= 0 && matched[nodes[node].fn]) ? 0.28 : 1
      const name = fn < 0 ? ROOT_NAME : profile.names[fn]
      // A row drawn upward has its top edge where the next row starts.
      const [x, y] = api.coord([rect.x, rootAtBottom ? rect.row + 1 : rect.row])

      return {
        type: 'rect',
        shape: { x, y, width: Math.max(rect.width - 1, 0.5), height: ROW_HEIGHT - 1 },
        style: { fill: fn < 0 ? ROOT_FILL : fills[fn], opacity },
        emphasis: { style: { stroke: DARK_INK } },
        textConfig: { position: 'insideLeft', distance: 3 },
        textContent: {
          type: 'text',
          style:
            rect.width > 24
              ? { text: rect.chain.length > 1 ? `(${rect.chain.length}) ${name}` : name, fill: DARK_INK, font: FONT, width: rect.width - 6, overflow: 'truncate', ellipsis: '\u2026', opacity }
              : { text: '' },
        },
      }
    }

    return {
      animation: false,
      grid: { left: 0, right: 0, top: 0, bottom: 0, outerBoundsMode: 'none' as const },
      xAxis: { type: 'value' as const, show: false, min: 0, max: width },
      yAxis: { type: 'value' as const, show: false, inverse: !rootAtBottom, min: 0, max: layout.rows },
      tooltip: {
        ...tooltipStyle,
        trigger: 'item' as const,
        appendToBody: true,
        // The tip sits below and right of the pointer, and flips where it would leave the window.
        position: (point: number[], _params: unknown, dom: HTMLElement) => {
          const { left, top } = chartRef.current!.ele.getBoundingClientRect()
          const place = (pointer: number, size: number, view: number) => (pointer + 14 + size > view - 12 ? Math.max(12, pointer - size - 14) : pointer + 14)

          return [place(left + point[0], dom.offsetWidth, window.innerWidth) - left, place(top + point[1], dom.offsetHeight, window.innerHeight) - top]
        },
        formatter: ({ value, dataIndex }: { value: number[]; dataIndex: number }) => {
          const node = nodes[value[2]]
          const { chain, ancestor } = layout.rects[dataIndex]
          const folded = chain.slice(1).map((at) => profile.names[nodes[at].fn])
          const foldedLine = folded.length > 0 ? `<div style="color:${mutedColor}">${format.encodeHTML(`and ${folded.length} similar ${folded.length === 1 ? 'frame' : 'frames'} (${folded.join(' > ')})`)}</div>` : ''
          // The self value of a collapsed row is the part of the row that no callee row covers.
          const self = chain.reduce((sum, at) => sum + nodes[at].self[type], 0)
          const click = clickMode === 'zoom' ? 'Click to zoom.' : value[3] !== nodes[0].fn ? 'Click to show its callers and callees.' : ''

          return (
            `<div style="font-family:${FONT_FAMILY};white-space:normal;word-break:break-all;max-width:min(560px,calc(100vw - 24px))">${format.encodeHTML(node.fn < 0 ? ROOT_NAME : profile.names[node.fn])}${foldedLine}</div>` +
            '<table style="border-collapse:collapse;margin:6px 0;font-variant-numeric:tabular-nums">' +
            tableRow(rootAtBottom ? 'Through this caller' : 'With callees', formatValue(sampleType, node.total[type]), formatShare(node.total[type], whole)) +
            (rootAtBottom ? '' : tableRow('Self', formatValue(sampleType, self), formatShare(self, whole))) +
            (inSandwich
              ? tableRow('Of selected function', '', formatShare(node.total[type], nodes[0].total[type]))
              : zoom === 0 || ancestor
                ? ''
                : tableRow('Of zoomed frame', '', formatShare(node.total[type], nodes[zoom].total[type]))) +
            '</table>' +
            (click && `<div style="color:${mutedColor}">${click}</div>`)
          )
        },
      },
      aria: { enabled: true, label: { description: inSandwich ? `${rootAtBottom ? 'Callers' : 'Callees'} of the selected function.` : 'Flamegraph. The top functions table lists the same data.' } },
      series: [{ type: 'custom' as const, data: layout.rects.map((rect) => [rect.x, rect.row, rect.node, nodes[rect.node].fn]), renderItem }],
    }
  }, [clickMode, fills, inSandwich, isDark, layout, matched, nodes, profile, rootAtBottom, sampleType, type, whole, width, zoom])

  return (
    <div ref={containerRef} className="max-h-[70vh] overflow-auto rounded-xs border border-gray-200 dark:border-gray-700">
      <ReactECharts ref={chartRef} option={option} style={{ height: `${layout.rows * ROW_HEIGHT}px`, width: '100%' }} opts={{ renderer: 'svg' }} onEvents={onEvents} />
    </div>
  )
}

/**
 * The props of the wrapper of a flamegraph slot. A slot stays mounted, because a new chart draws empty and
 * squashed frames before its first correct frame. A slot that does not show collapses, and its negative
 * margin cancels the gap above it.
 */
const slotProps = (shown: boolean) => (shown ? {} : { className: '-mt-2 h-0 overflow-hidden', 'aria-hidden': true })

/** The direction and the largest height of the name layer of a hovered row. */
interface NameLayer {
  upward: boolean
  maxHeight: number
}

/**
 * The name layer of a row that the pointer enters, or null when the full name fits in the
 * row. The layer opens downward where it fits in the visible part of the nearest scroll
 * area, and else toward the larger room. It stays in that room, and cuts a longer name at
 * its edge. The hover style applies before the event, so the scroll height of the layer
 * is the height of the full name.
 */
function placeNameLayer(row: HTMLTableRowElement): NameLayer | null {
  const cell = row.cells[0]
  const nameHeight = cell.firstElementChild!.scrollHeight
  if (nameHeight <= cell.clientHeight) return null
  let area: HTMLElement = row
  while (area.parentElement && getComputedStyle(area).overflowY === 'visible') area = area.parentElement
  const view = area.getBoundingClientRect()
  const { top, bottom } = row.getBoundingClientRect()
  const roomBelow = Math.min(view.bottom, window.innerHeight) - top
  const roomAbove = bottom - Math.max(view.top, 0)
  const upward = nameHeight > roomBelow && roomAbove > roomBelow
  return { upward, maxHeight: upward ? roomAbove : roomBelow }
}

interface FunctionRowProps {
  name: string
  selected: boolean
  onSelect: () => void
  /** The value cells of the row. */
  children: React.ReactNode
}

/**
 * A row of the functions table. The name shows on one line. On hover it shows in full in a
 * layer over the next rows, so the row height does not change. The row keeps the place of
 * its layer, so that a hover renders only this row.
 */
function FunctionRow({ name, selected, onSelect, children }: FunctionRowProps) {
  const [nameLayer, setNameLayer] = useState<NameLayer | null>(null)

  return (
    <tr
      onClick={onSelect}
      onMouseEnter={(event) => flushSync(() => setNameLayer(placeNameLayer(event.currentTarget)))}
      className={clsx(
        'group cursor-pointer border-b border-gray-200 last:border-0 hover:bg-gray-200 dark:border-gray-700 dark:hover:bg-gray-800',
        selected && 'bg-gray-200 dark:bg-gray-800',
      )}
    >
      <td className="relative">
        <div
          style={{ maxHeight: nameLayer?.maxHeight }}
          className={clsx(
            'pointer-events-none absolute top-0 right-7.5 left-0 min-h-full truncate py-1.5 pr-1.5 pl-3 break-all group-hover:whitespace-normal',
            nameLayer && 'group-hover:z-10 group-hover:bg-gray-200 group-hover:shadow-md group-hover:ring-1 group-hover:ring-gray-300 dark:group-hover:bg-gray-800 dark:group-hover:ring-gray-600',
            nameLayer?.upward && 'group-hover:top-auto group-hover:bottom-0',
          )}
        >
          {name}
        </div>
        <CopyButton value={name} className="absolute top-1/2 right-1.5 size-6 -translate-y-1/2 cursor-pointer" />
      </td>
      {children}
    </tr>
  )
}

interface ProfileViewProps {
  profile: Profile
  peakHeapBytes: number
  peakStackBytes: number
}

function ProfileView({ profile, peakHeapBytes, peakStackBytes }: ProfileViewProps) {
  const [typeName, setTypeName] = useState('cost')
  const [search, setSearch] = useState('')
  // A row of the functions table highlights its own function rather than every name that holds it.
  const [exact, setExact] = useState(false)
  const [zoom, setZoom] = useState(0)
  const [clickMode, setClickMode] = useState<ClickMode>('zoom')
  const [similarFrames, setSimilarFrames] = useState<SimilarFrames>('collapse')
  // The function whose callers and callees show in place of the flamegraph, -1 for none.
  const [sandwichFn, setSandwichFn] = useState(-1)
  const [showAll, setShowAll] = useState(false)
  const [sortBy, setSortBy] = useState<FunctionSortField>('self')
  const [sortOrder, setSortOrder] = useState<SortOrder>('desc')
  const flameRef = useRef<HTMLDivElement>(null)

  const { types, totalType, nodes } = profile
  const type = types.findIndex((sampleType) => sampleType.name === typeName)
  const sampleType = types[type]
  const whole = nodes[0].total[type]

  const matched = useMemo(() => {
    const query = search.trim()
    if (!query) return null
    return profile.names.map((name) => (exact ? name === query : name.toLowerCase().includes(query.toLowerCase())))
  }, [profile, search, exact])

  const sandwich = useMemo(() => (sandwichFn < 0 ? null : sandwichOf(profile, sandwichFn)), [profile, sandwichFn])
  // The callees slot draws a tree with only an empty root outside the sandwich view.
  const emptyTree = useMemo((): CallNode[] => [{ fn: -1, parent: -1, children: [], total: new Float64Array(types.length), self: new Float64Array(types.length) }], [types.length])

  const sortsSelf = sortBy === 'self' || sortBy === 'selfShare'
  const listsTop = sortBy !== 'function' && sortOrder === 'desc'
  // The table lists only the functions that the search highlights, as in Grafana.
  const functions = useMemo(() => {
    const values = sortsSelf ? profile.fnSelf : profile.fnTotal
    return sortNullsLast(
      [...profile.names.keys()].filter((fn) => profile.fnTotal[fn][type] > 0 && (!matched || matched[fn])),
      (fn) => (sortBy === 'function' ? profile.names[fn] : values[fn][type]),
      sortOrder,
    )
  }, [profile, type, sortBy, sortsSelf, sortOrder, matched])

  const typeIndexes = [...types.keys()]
  const costOptions = [totalType, ...typeIndexes.filter((index) => types[index].kind === 'cost' && index !== totalType)].map((index) => ({
    value: types[index].name,
    label: index === totalType ? types[index].name : `${types[index].name} ${formatShare(nodes[0].total[index], nodes[0].total[totalType])}`,
  }))
  const otherOptions = typeIndexes.filter((index) => types[index].kind !== 'cost').map((index) => ({ value: types[index].name, label: typeLabel(types[index]) }))
  const selectType = (name: string) => {
    setTypeName(name)
    setZoom(0)
  }

  const resetView = () => {
    setSandwichFn(-1)
    setZoom(0)
  }

  const selectClickMode = (mode: ClickMode) => {
    setClickMode(mode)
    if (mode !== clickMode) resetView()
  }

  const selectFunction = (fn: number) => {
    if (clickMode === 'sandwich') {
      setSandwichFn(fn)
    } else {
      const searched = exact && search === profile.names[fn]
      setSearch(searched ? '' : profile.names[fn])
      setExact(!searched)
    }
    flameRef.current!.scrollIntoView({ block: 'nearest' })
  }

  const handleSort = (field: FunctionSortField, order: SortOrder) => {
    setSortBy(field)
    setSortOrder(order)
  }

  const header = (text: string, field: FunctionSortField) => (
    <th scope="col" className="px-3 py-2 text-right">
      <SortHeader label={text} field={field} currentSort={sortBy} currentOrder={sortOrder} onSort={handleSort} align="right" />
    </th>
  )

  const cell = (value: number) => (sampleType.kind === 'heap' ? formatBytes(value) : formatCost(value))
  const zoomPath = pathTo(nodes, zoom)
  const flameGraphProps = { profile, type, matched, clickMode, onZoom: setZoom, onSandwich: setSandwichFn }
  // A function with no value for the type shows a caption in place of its callers and callees.
  const showsHalves = sandwich !== null && profile.fnTotal[sandwichFn][type] > 0
  const showsCaption = sandwich !== null && !showsHalves

  return (
    <div className="flex flex-col gap-4">
      <div className="grid grid-cols-2 gap-2 sm:grid-cols-5">
        <StatCard label="Total Cost" value={formatValue(types[totalType], nodes[0].total[totalType])} />
        <StatCard label="Peak Heap" value={formatBytes(peakHeapBytes)} />
        <StatCard label="Peak Stack" value={formatBytes(peakStackBytes)} />
        <StatCard label="Samples" value={formatNumber(profile.sampleCount)} />
        <StatCard label="Functions" value={formatNumber(profile.names.length)} />
      </div>

      <div className="flex flex-wrap items-center gap-2">
        <SegmentedControl value={typeName} onChange={selectType} options={costOptions} ariaLabel="Cost" className="flex-wrap" />
        <SegmentedControl value={typeName} onChange={selectType} options={otherOptions} ariaLabel="Calls and heap growth" />
      </div>

      <div className="flex flex-wrap items-center gap-3">
        <input
          type="search"
          value={search}
          onChange={(event) => {
            setSearch(event.target.value)
            setExact(false)
          }}
          onKeyDown={(event) => {
            // Escape clears a search and does not reach the modal, which closes on Escape.
            if (event.key === 'Escape' && search) {
              event.preventDefault()
              event.stopPropagation()
              setSearch('')
              setExact(false)
            }
          }}
          placeholder="Search functions..."
          aria-label="Search functions"
          className="w-72 max-w-full rounded-xs border border-gray-300 bg-white px-2 py-1 text-xs/5 placeholder-gray-400 focus:border-blue-500 focus:outline-hidden focus:ring-1 focus:ring-blue-500 dark:border-gray-600 dark:bg-gray-700 dark:text-gray-100 dark:placeholder-gray-500"
        />
        {matched && (
          <span className="text-xs/5 text-gray-500 tabular-nums dark:text-gray-400">
            Matches and their callees hold {formatShare(matchedTotal(profile, matched, type), whole)} of the {typeLabel(sampleType)}
          </span>
        )}
      </div>

      <div ref={flameRef} className="flex flex-col gap-2">
        <div className="flex items-center justify-between gap-2">
          <nav aria-label="Frame path" className="flex min-w-0 flex-wrap items-center gap-x-1.5 font-mono text-xs/5 text-gray-500 dark:text-gray-400">
            {sandwichFn < 0 && zoomPath.map((node, index) => {
              const label = node === 0 ? ROOT_NAME : profile.names[nodes[node].fn]
              return (
                <Fragment key={node}>
                  {index > 0 && <span className="text-gray-400 dark:text-gray-500">&gt;</span>}
                  {index === zoomPath.length - 1 ? (
                    <span title={label} className="truncate text-gray-900 dark:text-gray-100">{label}</span>
                  ) : (
                    <button
                      type="button"
                      title={label}
                      onClick={() => setZoom(node)}
                      className="truncate underline decoration-gray-300 underline-offset-2 hover:text-gray-900 dark:decoration-gray-600 dark:hover:text-gray-100"
                    >
                      {label}
                    </button>
                  )}
                </Fragment>
              )
            })}
            {sandwichFn >= 0 && (
              <>
                <button
                  type="button"
                  onClick={resetView}
                  className="underline decoration-gray-300 underline-offset-2 hover:text-gray-900 dark:decoration-gray-600 dark:hover:text-gray-100"
                >
                  {ROOT_NAME}
                </button>
                <span className="text-gray-400 dark:text-gray-500">&gt;</span>
                <span title={profile.names[sandwichFn]} className="truncate text-gray-900 dark:text-gray-100">
                  {profile.names[sandwichFn]}
                </span>
              </>
            )}
          </nav>
          <div className="flex shrink-0 items-center gap-2">
            {(zoom !== 0 || sandwichFn >= 0) && (
              <button type="button" onClick={resetView} className="text-xs/5 text-blue-600 hover:text-blue-800 dark:text-blue-400 dark:hover:text-blue-300">
                Reset
              </button>
            )}
            <div className="flex items-center gap-1.5 text-xs/5 text-gray-500 dark:text-gray-400">
              <span>Click:</span>
              <SegmentedControl value={clickMode} onChange={selectClickMode} options={CLICK_MODES} ariaLabel="Click action" />
            </div>
            {sandwichFn < 0 && (
              <div className="flex items-center gap-1.5 text-xs/5 text-gray-500 dark:text-gray-400">
                <span>Similar frames:</span>
                <SegmentedControl value={similarFrames} onChange={setSimilarFrames} options={SIMILAR_FRAMES} ariaLabel="Similar frames" />
              </div>
            )}
          </div>
        </div>
        {showsHalves && <div className="text-xs/5 font-medium text-gray-500 dark:text-gray-400">Callers</div>}
        <div key="top" {...slotProps(!showsCaption)}>
          <FlameGraph {...flameGraphProps} nodes={sandwich?.callers} rootAtBottom={sandwich !== null} collapsed={sandwich === null && similarFrames === 'collapse'} zoom={sandwich ? 0 : zoom} />
        </div>
        {showsHalves && <div className="text-xs/5 font-medium text-gray-500 dark:text-gray-400">Callees</div>}
        <div key="bottom" {...slotProps(showsHalves)}>
          <FlameGraph {...flameGraphProps} nodes={sandwich?.callees ?? emptyTree} zoom={0} />
        </div>
        {showsCaption && (
          <p className="text-xs/5 break-all text-gray-500 dark:text-gray-400">
            {profile.names[sandwichFn]} has no {typeLabel(sampleType)}.
          </p>
        )}
      </div>

      <div className="flex flex-col gap-2">
        <div className="flex items-center justify-between gap-2">
          <div className="text-xs/5 font-medium text-gray-500 dark:text-gray-400">
            Functions
          </div>
          {functions.length > TOP_FUNCTIONS && (
            <button
              type="button"
              onClick={() => setShowAll(!showAll)}
              className="flex w-fit cursor-pointer items-center gap-1 rounded-xs px-1.5 py-1 text-xs/5 font-medium text-gray-600 hover:bg-gray-100 hover:text-gray-900 dark:text-gray-400 dark:hover:bg-gray-700 dark:hover:text-gray-100"
            >
              {showAll
                ? <><ChevronUp className="size-3.5" /> Show {listsTop ? 'top' : 'first'} {TOP_FUNCTIONS}</>
                : <><ChevronDown className="size-3.5" /> Show all {functions.length}</>}
            </button>
          )}
        </div>
        <div className="rounded-xs bg-gray-100 dark:bg-gray-900">
          <table className="w-full text-left text-xs/5">
            <thead>
              <tr className="border-b border-gray-200 whitespace-nowrap text-gray-500 dark:border-gray-700 dark:text-gray-400">
                <th scope="col" className="w-full px-3 py-2">
                  <SortHeader label="Function" field="function" currentSort={sortBy} currentOrder={sortOrder} onSort={handleSort} />
                </th>
                {header('Self', 'self')}
                {header('Self Share', 'selfShare')}
                {header('Total', 'total')}
                {header('Total Share', 'totalShare')}
              </tr>
            </thead>
            <tbody className="font-mono text-gray-900 dark:text-gray-100">
              {(showAll ? functions : functions.slice(0, TOP_FUNCTIONS)).map((fn) => (
                <FunctionRow key={fn} name={profile.names[fn]} selected={fn === sandwichFn} onSelect={() => selectFunction(fn)}>
                  <td className="px-3 py-1.5 text-right whitespace-nowrap">{cell(profile.fnSelf[fn][type])}</td>
                  <td className="px-3 py-1.5 text-right whitespace-nowrap">{formatShare(profile.fnSelf[fn][type], whole)}</td>
                  <td className="px-3 py-1.5 text-right whitespace-nowrap">{cell(profile.fnTotal[fn][type])}</td>
                  <td className="px-3 py-1.5 text-right whitespace-nowrap">{formatShare(profile.fnTotal[fn][type], whole)}</td>
                </FunctionRow>
              ))}
              {functions.length === 0 && (
                <tr>
                  <td colSpan={5} className="px-3 py-6 text-center font-sans text-gray-500 dark:text-gray-400">
                    No functions match the search.
                  </td>
                </tr>
              )}
            </tbody>
          </table>
        </div>
      </div>
    </div>
  )
}

interface TestProfileProps {
  runId: string
  testName: string
  peakHeapBytes: number
  peakStackBytes: number
}

/**
 * TestProfile is the profile tab of the test modal. It draws the pprof of one
 * test as a flamegraph of the selected sample type, colored by the hot palette.
 */
export function TestProfile({ runId, testName, peakHeapBytes, peakStackBytes }: TestProfileProps) {
  const { data: profile, isLoading, error } = useTestProfile(runId, testName)

  if (isLoading) {
    return (
      <div className="flex items-center justify-center py-4">
        <div className="size-5 animate-spin rounded-full border-2 border-gray-300 border-t-blue-600" />
        <span className="ml-2 text-sm/6 text-gray-500 dark:text-gray-400">Loading profile...</span>
      </div>
    )
  }

  if (error) {
    return <p className="py-2 text-sm/6 text-red-600 dark:text-red-400">{error.message}</p>
  }

  if (!profile) {
    return <p className="py-2 text-sm/6 text-gray-500 dark:text-gray-400">No profile data available</p>
  }

  return <ProfileView profile={profile} peakHeapBytes={peakHeapBytes} peakStackBytes={peakStackBytes} />
}

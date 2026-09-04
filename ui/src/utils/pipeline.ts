import type { PipelinePhase, PipelineTaskRow, TestPipeline } from '@/api/types'

/** One hue per phase, in draw order, far enough apart to read on either theme. */
export const PHASE_COLOR: Record<PipelinePhase, string> = {
  execution: '#d97a3d',
  witness: '#5b7fd6',
  base: '#4fa58a',
  recursion: '#b06ab3',
  wrap: '#d4c36a',
}

/** Neutral shade a kind of a phase no hue names draws in, readable on either theme. */
export const UNNAMED_PHASE_COLOR = '#9ca3af'

/** Phases in draw order, which is the order the legend groups the entries in. */
const PHASE_ORDER = Object.keys(PHASE_COLOR) as PipelinePhase[]

/** Lightness steps in percent the kinds of one phase cycle through, from the phase color down. */
const SHADE_STEPS = [0, -10, -20, -30]

/** Saturation step in percent every next cycle of the lightness steps adds. */
const SATURATION_STEP = 30

/**
 * kindShade paints one legend entry in the hue of its phase. The first entry of
 * a phase keeps the phase color, the next three darken it by ten points each in
 * the order the proofs follow, and every further cycle raises the saturation, so
 * the entries of one phase read as one gradient on either theme. Two cycles hold
 * eight entries apart, and a ninth reaches the CSS saturation ceiling.
 */
export function kindShade(phase: PipelinePhase, index: number): string {
  const hex = PHASE_COLOR[phase]
  const [red, green, blue] = [1, 3, 5].map((at) => parseInt(hex.slice(at, at + 2), 16) / 255)
  const high = Math.max(red, green, blue)
  const low = Math.min(red, green, blue)
  const span = high - low
  const lightness = (high + low) / 2
  const turn = high === red ? (green - blue) / span : high === green ? (blue - red) / span + 2 : (red - green) / span + 4
  const step = SHADE_STEPS[index % SHADE_STEPS.length]
  const spread = Math.floor(index / SHADE_STEPS.length) * SATURATION_STEP

  return `hsl(${Math.round((((turn % 6) + 6) % 6) * 60)}, ${Math.round((span / (1 - Math.abs(2 * lightness - 1))) * 100) + spread}%, ${Math.round(lightness * 100) + step}%)`
}

/** One legend entry, the kinds the artifact draws under it and the shade their bars carry. */
export interface PipelineKindShade {
  label: string
  color: string
}

/** One task of the timeline, its kind and its window on the coordinator clock. */
export interface PipelineItem {
  kind: number
  label: string
  color: string
  workerIndex: number
  workerName: string
  nodeName: string
  /** Display id of the task, empty when its kind runs once per proof. */
  id: string
  /** Row group of the kind, which splits the tasks of one id over rows. */
  row: string
  startSec: number
  endSec: number
  /** Sub step timings as [breakdown index, ms] pairs, empty when the task reports none. */
  breakdown: Array<[number, number]>
  /** Every breakdown index a task of the kind reports, so the hover table of the kind holds still. */
  sections: number[]
}

/** One drawn line of the chart, the items painted on it in start order. */
export interface PipelineRow {
  /** The row group, then the id when the row carries one. */
  title: string
  items: PipelineItem[]
  startSec: number
}

export interface PipelineModel {
  items: PipelineItem[]
  /** Worker names in wire order. */
  workers: string[]
  kindsUsed: PipelineKindShade[]
  endSec: number
}

/** One line of the hover table, a sub step with its duration and its share. */
export interface BreakdownRow {
  label: string
  seconds: number
  share: number
}

const isPair = (value: unknown): value is [number, number] =>
  Array.isArray(value) && value.length === 2 && value.every((cell) => typeof cell === 'number' && Number.isFinite(cell))

const isIndex = (value: unknown, limit: number) => typeof value === 'number' && Number.isInteger(value) && value >= 0 && value < limit

function validTask(row: PipelineTaskRow, kinds: number, workers: number): boolean {
  if (!Array.isArray(row) || row.length !== 6) return false
  const [kind, worker, id, startMs, durationMs, breakdown] = row

  return (
    isIndex(kind, kinds) &&
    isIndex(worker, workers) &&
    typeof id === 'string' &&
    Number.isFinite(startMs) &&
    Number.isFinite(durationMs) &&
    Array.isArray(breakdown) &&
    breakdown.every(isPair)
  )
}

/**
 * decodePipeline turns the wire rows into items in seconds. A row that does not
 * match the shape is dropped, so one bad task never blanks the chart, and a kind
 * whose phase the legend has no hue for draws in the neutral shade. The kinds of
 * one legend entry share the shade of the entry. An artifact of an early build
 * names no legend entry and no row group, so the label names both.
 */
export function decodePipeline(pipeline: TestPipeline): PipelineModel {
  const { kinds, workers } = pipeline
  const kindLegends = kinds.map((kind) => kind.legend ?? kind.label)
  const kindRows = kinds.map((kind) => kind.row ?? kind.label)
  const phaseLegends = new Map<PipelinePhase, string[]>()
  const colors = kinds.map((kind, index) => {
    if (!Object.prototype.hasOwnProperty.call(PHASE_COLOR, kind.phase)) return UNNAMED_PHASE_COLOR
    const legends = phaseLegends.get(kind.phase) ?? []
    if (!legends.includes(kindLegends[index])) legends.push(kindLegends[index])
    phaseLegends.set(kind.phase, legends)

    return kindShade(kind.phase, legends.indexOf(kindLegends[index]))
  })
  const rows = pipeline.tasks.filter((row) => validTask(row, kinds.length, workers.length))
  const sections = kinds.map((_, kind) =>
    [...new Set(rows.filter((row) => row[0] === kind).flatMap((row) => row[5].map(([index]) => index)))].sort((a, b) => a - b),
  )
  const items = rows.map(([kind, worker, id, startMs, durationMs, breakdown]) => ({
    kind,
    label: kinds[kind].label,
    color: colors[kind],
    workerIndex: worker,
    workerName: workers[worker].name,
    nodeName: workers[worker].node,
    id,
    row: kindRows[kind],
    startSec: startMs / 1000,
    endSec: (startMs + durationMs) / 1000,
    breakdown,
    sections: sections[kind],
  }))
  const legendsUsed = new Map<string, string>()
  ;[...new Set(items.map((item) => item.kind))]
    .sort((a, b) => PHASE_ORDER.indexOf(kinds[a].phase) - PHASE_ORDER.indexOf(kinds[b].phase) || a - b)
    .forEach((index) => {
      if (!legendsUsed.has(kindLegends[index])) legendsUsed.set(kindLegends[index], colors[index])
    })

  return {
    items,
    workers: workers.map((worker) => worker.name),
    kindsUsed: [...legendsUsed].map(([label, color]) => ({ label, color })),
    endSec: items.reduce((end, item) => Math.max(end, item.endSec), 0),
  }
}

/**
 * packRows folds every item that carries an id onto the row of the first item
 * with the same row group and id on the same worker, and gives every item with
 * no id a row of its own.
 */
export function packRows(items: PipelineItem[]): PipelineRow[] {
  const key = (item: PipelineItem) => `${item.workerIndex}:${item.row}:${item.id}`
  const hostRow = new Map<string, number>()
  items.forEach((item, index) => {
    if (item.id !== '' && !hostRow.has(key(item))) hostRow.set(key(item), index)
  })

  const buckets = new Map<number, PipelineItem[]>()
  items.forEach((item, index) => {
    const row = hostRow.get(key(item)) ?? index
    const bucket = buckets.get(row)
    if (bucket) bucket.push(item)
    else buckets.set(row, [item])
  })

  return [...buckets.values()]
    .map((bucket) => {
      const rowItems = [...bucket].sort((a, b) => a.startSec - b.startSec)
      const { row, id } = rowItems[0]

      return { title: id === '' ? row : `${row} - ${id}`, items: rowItems, startSec: rowItems[0].startSec }
    })
    .sort((a, b) => a.startSec - b.startSec || a.items[0].workerIndex - b.items[0].workerIndex || a.items[0].kind - b.items[0].kind)
}

/** Share of the bar the unattributed remainder needs before it earns a row. */
const UNATTRIBUTED_FLOOR = 0.01

/**
 * breakdownRows lists the sub steps of a task with their share of its bar. The
 * table names every section its kind reports anywhere in the artifact, at zero
 * when this task lacks one, so two bars of one kind compare line by line. The
 * Total row is the bar, so the table closes on the window of the task. Sub
 * steps that fall short of the bar leave an unattributed remainder the table
 * names once it reaches the floor, and sub steps that overrun the bar read
 * past one.
 */
export function breakdownRows(item: PipelineItem, labels: string[]): BreakdownRow[] {
  if (item.sections.length === 0) return []
  const duration = item.endSec - item.startSec
  const sum = item.breakdown.reduce((added, [, ms]) => added + ms / 1000, 0)
  const share = (seconds: number) => (duration > 0 ? seconds / duration : 0)
  const measured = new Map(item.breakdown)
  const rows = item.sections.map((index) => {
    const seconds = (measured.get(index) ?? 0) / 1000

    return { label: labels[index] ?? `#${index}`, seconds, share: share(seconds) }
  })
  if (share(duration - sum) >= UNATTRIBUTED_FLOOR) rows.push({ label: 'Unattributed', seconds: duration - sum, share: share(duration - sum) })

  return [...rows, { label: 'Total', seconds: duration, share: 1 }]
}

/** Row pitch and bar height in px, denser as the timeline grows. */
export function rowPitch(count: number): { pitch: number; bar: number } {
  if (count <= 800) return { pitch: 8, bar: 6 }
  if (count <= 3000) return { pitch: 5, bar: 4 }

  return { pitch: 3, bar: 2 }
}

/** The task a row draws, its kind then its id. */
export function itemTitle(item: PipelineItem): string {
  return item.id === '' ? item.label : `${item.label} - ${item.id}`
}

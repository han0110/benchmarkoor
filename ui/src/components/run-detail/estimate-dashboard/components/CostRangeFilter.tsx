import { useState } from 'react'
import { formatCost, parseCost } from '@/utils/estimate'
import type { EstimateState } from '../types'

type CostRange = Pick<EstimateState, 'minCost' | 'maxCost'>

const STEPS = 1000

const SLIDER_CLASS =
  'pointer-events-none absolute h-1 w-full appearance-none rounded-sm [&::-webkit-slider-thumb]:pointer-events-auto [&::-webkit-slider-thumb]:size-3 [&::-webkit-slider-thumb]:appearance-none [&::-webkit-slider-thumb]:rounded-full [&::-webkit-slider-thumb]:bg-blue-500 [&::-webkit-slider-thumb]:hover:bg-blue-600'

interface CostFieldProps {
  cost?: number
  placeholder: string
  onChange: (cost?: number) => void
}

/** A field that applies its text on Enter or on blur, so it does not format the text while the user types. Empty text clears the bound. Text that is not a cost leaves the bound, and the field shows it again. */
function CostField({ cost, placeholder, onChange }: CostFieldProps) {
  const [draft, setDraft] = useState<string>()
  const apply = () => {
    const parsed = parseCost(draft ?? '')
    if (parsed !== undefined || draft?.trim() === '') onChange(parsed)
    setDraft(undefined)
  }

  return (
    <input
      type="text"
      placeholder={placeholder}
      value={draft ?? (cost === undefined ? '' : formatCost(cost))}
      onChange={(e) => setDraft(e.target.value)}
      onKeyDown={(e) => {
        if (e.key === 'Enter') apply()
      }}
      onBlur={apply}
      className="w-20 rounded-sm border border-gray-300 bg-white px-2 py-1 text-sm dark:border-gray-600 dark:bg-gray-700 dark:text-gray-100"
    />
  )
}

interface CostSliderProps {
  min?: number
  max?: number
  lowest: number
  highest: number
  onChange: (range: CostRange) => void
}

/** A pair of sliders on a log scale, because the costs span several orders of magnitude. A thumb at its end clears its bound. */
function CostSlider({ min, max, lowest, highest, onChange }: CostSliderProps) {
  const span = Math.log(highest / lowest)
  // A bound below the lowest cost puts its thumb at the near end.
  const positionOf = (cost: number) => (STEPS * Math.log(Math.max(cost, lowest) / lowest)) / span
  const costAt = (position: number) => Math.round(lowest * Math.exp((span * position) / STEPS))

  return (
    <div className="relative flex w-32 items-center">
      <input
        type="range"
        min={0}
        max={STEPS}
        value={min === undefined ? 0 : positionOf(min)}
        onChange={(e) => {
          const position = Number(e.target.value)
          onChange({ minCost: position > 0 ? Math.min(costAt(position), max ?? highest) : undefined })
        }}
        className={`${SLIDER_CLASS} bg-gray-200 dark:bg-gray-600`}
      />
      <input
        type="range"
        min={0}
        max={STEPS}
        value={max === undefined ? STEPS : positionOf(max)}
        onChange={(e) => {
          const position = Number(e.target.value)
          onChange({ maxCost: position < STEPS ? Math.max(costAt(position), min ?? lowest) : undefined })
        }}
        className={`${SLIDER_CLASS} bg-transparent`}
      />
    </div>
  )
}

interface CostRangeFilterProps {
  min?: number
  max?: number
  /** The lowest estimated cost of the data, which is the near end of the sliders. */
  lowest: number | null
  /** The highest estimated cost of the data, which is the far end of the sliders. Without two different costs, the fields alone remain. */
  highest: number | null
  onChange: (range: CostRange) => void
}

/** The cost range of the estimate filter bar, two fields and a pair of sliders between them. */
export function CostRangeFilter({ min, max, lowest, highest, onChange }: CostRangeFilterProps) {
  return (
    <div className="flex items-center gap-2">
      <span className="text-xs text-gray-500 dark:text-gray-400">Cost:</span>
      <CostField cost={min} placeholder="Min" onChange={(minCost) => onChange({ minCost })} />
      {lowest !== null && highest !== null && lowest < highest && <CostSlider min={min} max={max} lowest={lowest} highest={highest} onChange={onChange} />}
      <CostField cost={max} placeholder="Max" onChange={(maxCost) => onChange({ maxCost })} />
    </div>
  )
}

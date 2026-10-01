import { useMemo, useState } from 'react'
import clsx from 'clsx'
import { Layers } from 'lucide-react'
import { GroupBySelect } from '@/components/compare/EstimatedCostDimensions'
import { COMPARED_VALUES, groupDimensions, type ComparedValue } from '@/components/compare/estimateComparison'
import { SegmentedControl } from '@/components/shared/SegmentedControl'
import { searchQueryContains } from '@/utils/eestNameFilter'
import { costTitle, formatCost, formatPercent } from '@/utils/estimate'
import { SortHeader } from '../../block-logs-dashboard/components/BlockLogsTable'
import type { SortOrder } from '../../block-logs-dashboard/types'
import { orDash, sortDimensionRows, summariseByDimension } from '../utils/rows'
import type { DimensionSortField, EstimateRow } from '../types'
import { FitError } from './EstimateTable'

const COMPARED: { value: ComparedValue; label: string }[] = (['cost', 'heap'] as const).map((value) => ({ value, label: COMPARED_VALUES[value].label }))

/** The sorts that the peak heap keeps, since Share, the kinds, and the fit error read cost alone. */
const HEAP_SORTS = new Set<DimensionSortField>(['value', 'tests', 'failed', 'max', 'mean'])

interface DimensionTableProps {
  /** The rows the filters keep. */
  rows: EstimateRow[]
  /** The failed tests the filters keep. */
  failures: string[]
  kinds: string[]
  /** Offers the peak heap beside the cost, which only some servers report. */
  reportsHeap: boolean
  /** Prints each kind as its share of the group rather than as its mean cost. */
  costShare: boolean
  onCostShareChange: (costShare: boolean) => void
  /** Prints the fitted error signed rather than unsigned. */
  signedError: boolean
  onSignedErrorChange: (signedError: boolean) => void
  /** Prints the fitted error column, which an estimate without block logs has nothing for. */
  hasTiming: boolean
  /** The page search, whose terms keep their dimensions listed and mark the groups they pin. */
  searchQuery?: string
  onSearchTermToggle?: (term: string) => void
}

/** The cost or the peak heap of the kept tests, grouped by one part of the test name. */
export function DimensionTable({ rows, failures, kinds, reportsHeap, costShare, onCostShareChange, signedError, onSignedErrorChange, hasTiming, searchQuery = '', onSearchTermToggle }: DimensionTableProps) {
  const [comparedValue, setComparedValue] = useState<ComparedValue>('cost')
  const [dimensionKey, setDimensionKey] = useState('file')
  const [sortBy, setSortBy] = useState<DimensionSortField>('max')
  const [sortOrder, setSortOrder] = useState<SortOrder>('desc')

  const dimensions = useMemo(() => groupDimensions([...rows.map((row) => row.testName), ...failures], searchQuery), [rows, failures, searchQuery])
  // A dimension that the search narrows to one group without a term of its own falls back to the first dimension.
  const dimension = dimensions.find(({ key }) => key === dimensionKey) ?? dimensions[0]

  const groups = useMemo(
    () => (dimension ? sortDimensionRows(summariseByDimension(rows, failures, dimension.key, kinds, signedError, comparedValue), kinds, sortBy, sortOrder, costShare) : []),
    [rows, failures, dimension, kinds, signedError, comparedValue, sortBy, sortOrder, costShare],
  )

  if (!dimension) return null

  const isCost = comparedValue === 'cost'
  const { format } = COMPARED_VALUES[comparedValue]

  const handleSort = (field: DimensionSortField, order: SortOrder) => {
    setSortBy(field)
    setSortOrder(order)
  }

  const handleComparedValueChange = (value: ComparedValue) => {
    setComparedValue(value)
    if (value === 'heap' && !HEAP_SORTS.has(sortBy)) handleSort('max', 'desc')
  }

  const header = (text: string, field: DimensionSortField) => (
    <th key={field} scope="col" className="px-3 py-3 text-right text-xs">
      <SortHeader label={text} field={field} currentSort={sortBy} currentOrder={sortOrder} onSort={handleSort} align="right" />
    </th>
  )

  return (
    <div className="overflow-hidden rounded-sm bg-white shadow-xs dark:bg-gray-800">
      <div className="flex flex-wrap items-center justify-between gap-3 border-b border-gray-200 px-4 py-3 dark:border-gray-700">
        <h3 className="flex items-center gap-2 text-sm font-medium text-gray-900 dark:text-gray-100">
          <Layers className="size-4 text-gray-400 dark:text-gray-500" />
          {COMPARED_VALUES[comparedValue].label} by {dimension.label}
        </h3>
        <div className="flex flex-wrap items-center gap-4">
          {/* The checkboxes come first, so the selectors keep their place when Peak Heap hides them. */}
          {isCost && (
            <label className="flex cursor-pointer items-center gap-1.5 text-xs text-gray-600 dark:text-gray-400">
              <input
                type="checkbox"
                checked={costShare}
                onChange={(e) => onCostShareChange(e.target.checked)}
                className="rounded-xs border-gray-300 text-blue-600 focus:ring-blue-500 dark:border-gray-600"
              />
              Cost share
            </label>
          )}
          {isCost && hasTiming && (
            <label className="flex cursor-pointer items-center gap-1.5 text-xs text-gray-600 dark:text-gray-400">
              <input
                type="checkbox"
                checked={signedError}
                onChange={(e) => onSignedErrorChange(e.target.checked)}
                className="rounded-xs border-gray-300 text-blue-600 focus:ring-blue-500 dark:border-gray-600"
              />
              Signed error
            </label>
          )}
          {reportsHeap && <SegmentedControl value={comparedValue} onChange={handleComparedValueChange} options={COMPARED} ariaLabel="Value" />}
          <GroupBySelect dimensions={dimensions} value={dimension.key} onChange={setDimensionKey} />
        </div>
      </div>

      <div className="max-h-[70vh] overflow-auto">
        <table className="min-w-full divide-y divide-gray-200 whitespace-nowrap dark:divide-gray-700">
          <thead className="sticky top-0 z-10 bg-gray-50 dark:bg-gray-900">
            <tr>
              <th scope="col" className="px-3 py-3 text-left text-xs">
                <SortHeader label={dimension.label} field="value" currentSort={sortBy} currentOrder={sortOrder} onSort={handleSort} />
              </th>
              {header('Tests', 'tests')}
              {header('Failed', 'failed')}
              {header('Max', 'max')}
              {header('Mean', 'mean')}
              {isCost && header('Share', 'share')}
              {isCost && kinds.map((kind) => header(kind, `kind:${kind}`))}
              {isCost && hasTiming && header('Fitted Error', 'error')}
            </tr>
          </thead>
          <tbody className="divide-y divide-gray-200 dark:divide-gray-700">
            {groups.map((group) => {
              const groupTerm = `${dimension.key}=${group.value}`
              const active = searchQueryContains(searchQuery, groupTerm)
              // The query splits terms on whitespace, so a group with whitespace forms no term.
              const toggles = onSearchTermToggle && !/\s/.test(group.value)
              return (
                <tr
                  key={group.value}
                  onClick={toggles ? () => onSearchTermToggle(groupTerm) : undefined}
                  title={toggles ? (active ? `Click to remove ${groupTerm} from filter` : `Click to filter by ${groupTerm}`) : undefined}
                  className={clsx('transition-colors', toggles && 'cursor-pointer', active ? 'bg-blue-50 dark:bg-blue-950' : 'hover:bg-gray-50 dark:hover:bg-gray-700/50')}
                >
                  <td className={clsx('px-3 py-2 font-mono text-sm', active ? 'text-blue-900 dark:text-blue-200' : 'text-gray-900 dark:text-gray-100')}>{group.value}</td>
                  <td className="px-3 py-2 text-right font-mono text-sm text-gray-600 dark:text-gray-400">{group.tests}</td>
                  <td className={`px-3 py-2 text-right font-mono text-sm ${group.failed > 0 ? 'text-red-600 dark:text-red-400' : 'text-gray-600 dark:text-gray-400'}`}>
                    {group.failed}
                  </td>
                  <td title={isCost ? costTitle(group.max) : undefined} className="px-3 py-2 text-right font-mono text-sm text-gray-900 dark:text-gray-100">
                    {orDash(group.max, format)}
                  </td>
                  <td title={isCost ? costTitle(group.mean) : undefined} className="px-3 py-2 text-right font-mono text-sm text-gray-600 dark:text-gray-400">
                    {orDash(group.mean, format)}
                  </td>
                  {isCost && <td className="px-3 py-2 text-right font-mono text-sm text-gray-600 dark:text-gray-400">{orDash(group.share, formatPercent)}</td>}
                  {isCost && kinds.map((kind, at) => (
                    <td key={kind} title={costShare ? undefined : costTitle(group.kindMeans[at])} className="px-3 py-2 text-right font-mono text-sm text-gray-600 dark:text-gray-400">
                      {costShare ? orDash(group.kindShares[at], formatPercent) : orDash(group.kindMeans[at], formatCost)}
                    </td>
                  ))}
                  {isCost && hasTiming && (
                    <td className="px-3 py-2 text-right font-mono text-sm text-gray-600 dark:text-gray-400">
                      <FitError error={group.error} signed={signedError} />
                    </td>
                  )}
                </tr>
              )
            })}
          </tbody>
        </table>
      </div>
    </div>
  )
}

import { useMemo, useState } from 'react'
import clsx from 'clsx'
import { Layers } from 'lucide-react'
import type { RunEstimate } from '@/api/types'
import { EstimateBadge } from '@/components/estimates/EstimateCompareHeader'
import { SortHeader } from '@/components/run-detail/block-logs-dashboard/components/BlockLogsTable'
import type { SortDirection } from '@/components/runs/sortEntries'
import { costTitle, formatRatio, ratioClass } from '@/utils/estimate'
import { searchQueryContains } from '@/utils/eestNameFilter'
import type { CompareRun, LabelMode } from './constants'
import { COMPARED_VALUES, appliedSort, groupComparison, groupDimensions, sortGroups, type ComparedValue, type GroupDimension, type GroupSortField } from './estimateComparison'

interface EstimatedCostDimensionsProps {
  runs: CompareRun[]
  estimates: RunEstimate[]
  /** The tests the filter keeps that every estimate has the figure of. */
  sharedNames: string[]
  comparedValue: ComparedValue
  labelMode: LabelMode
  baselineIndex: number
  /** The filter query, which marks the groups it pins. */
  query: string
  onToggle: (term: string) => void
}

/** The select of the dimension a group table groups by, with the group count of each. */
export function GroupBySelect({ dimensions, value, onChange }: { dimensions: GroupDimension[]; value: string; onChange: (key: string) => void }) {
  return (
    <label className="ml-auto flex items-center gap-2 text-xs/5 text-gray-500 dark:text-gray-400">
      <span>Group by:</span>
      <select
        value={value}
        onChange={(e) => onChange(e.target.value)}
        className="rounded-xs border border-gray-300 bg-white px-2 py-0.5 text-xs/5 text-gray-700 focus:border-blue-500 focus:outline-hidden focus:ring-1 focus:ring-blue-500 dark:border-gray-600 dark:bg-gray-700 dark:text-gray-200"
      >
        {dimensions.map((option) => (
          <option key={option.key} value={option.key}>
            {option.label} ({option.groups})
          </option>
        ))}
      </select>
    </label>
  )
}

/** The shared tests grouped by one part of the test name, with the ratio of the group sums to the baseline. */
export function EstimatedCostDimensions({ runs, estimates, sharedNames, comparedValue, labelMode, baselineIndex, query, onToggle }: EstimatedCostDimensionsProps) {
  const [dimensionKey, setDimensionKey] = useState('file')
  const [sort, setSort] = useState<{ sortBy: GroupSortField; sortDir: SortDirection } | null>(null)
  const { sortBy, sortDir } = appliedSort(sort, baselineIndex)

  const dimensions = useMemo(() => groupDimensions(sharedNames, query), [sharedNames, query])
  // A dimension that the filter narrows to one group without a term of its own falls back to the first dimension.
  const dimension = dimensions.find(({ key }) => key === dimensionKey) ?? dimensions[0]

  const groups = useMemo(
    () => (dimension ? sortGroups(groupComparison(estimates, sharedNames, dimension.key, baselineIndex, comparedValue), sortBy, sortDir) : []),
    [estimates, sharedNames, dimension, baselineIndex, comparedValue, sortBy, sortDir],
  )

  if (!dimension) return null

  const { label, format } = COMPARED_VALUES[comparedValue]

  const onSort = (field: GroupSortField, order: SortDirection) => setSort({ sortBy: field, sortDir: order })

  const estimateHeader = (run: CompareRun, field: GroupSortField, fieldLabel: string) => (
    <th key={field} scope="col" className="px-3 py-2 text-right text-xs/5">
      <span className="flex flex-col items-end gap-1">
        <EstimateBadge run={run} labelMode={labelMode} />
        <SortHeader label={fieldLabel} field={field} currentSort={sortBy} currentOrder={sortDir} onSort={onSort} align="right" />
      </span>
    </th>
  )

  return (
    <div className="overflow-hidden rounded-sm bg-white shadow-xs dark:bg-gray-800">
      <div className="flex flex-wrap items-center gap-2 border-b border-gray-200 px-4 py-3 dark:border-gray-700">
        <Layers className="size-4 text-gray-400 dark:text-gray-500" />
        <h3 className="text-sm/6 font-medium text-gray-900 dark:text-gray-100">{label} by {dimension.label}</h3>
        <GroupBySelect dimensions={dimensions} value={dimension.key} onChange={setDimensionKey} />
      </div>
      <div className="max-h-[70vh] overflow-auto">
        <table className="min-w-full divide-y divide-gray-200 whitespace-nowrap dark:divide-gray-700">
          <thead className="sticky top-0 z-10 bg-gray-50 dark:bg-gray-900">
            <tr>
              <th scope="col" className="sticky left-0 z-20 bg-gray-50 px-3 py-2 text-left align-bottom text-xs/5 dark:bg-gray-900">
                <SortHeader label={dimension.label} field="group" currentSort={sortBy} currentOrder={sortDir} onSort={onSort} />
              </th>
              <th scope="col" className="px-3 py-2 text-right align-bottom text-xs/5">
                <SortHeader label="Tests" field="tests" currentSort={sortBy} currentOrder={sortDir} onSort={onSort} align="right" />
              </th>
              {runs.map((run, at) => estimateHeader(run, `mean:${at}`, 'Mean'))}
              {runs.map((run, at) => at !== baselineIndex && estimateHeader(run, `ratio:${at}`, 'Ratio'))}
            </tr>
          </thead>
          <tbody className="divide-y divide-gray-200 dark:divide-gray-700">
            {groups.map((group) => {
              const groupTerm = `${dimension.key}=${group.group}`
              const active = searchQueryContains(query, groupTerm)
              // The query splits terms on whitespace, so a group with whitespace forms no term.
              const toggles = !/\s/.test(group.group)
              return (
                <tr
                  key={group.group}
                  onClick={toggles ? () => onToggle(groupTerm) : undefined}
                  title={toggles ? (active ? `Click to remove ${groupTerm} from filter` : `Click to filter by ${groupTerm}`) : undefined}
                  className={clsx('group font-mono text-sm/6 text-gray-900 dark:text-gray-100', toggles && 'cursor-pointer', active ? 'bg-blue-50 dark:bg-blue-950' : 'hover:bg-gray-50 dark:hover:bg-gray-700')}
                >
                  <td
                    className={clsx(
                      'sticky left-0 max-w-xs truncate px-3 py-1.5',
                      active ? 'bg-blue-50 text-blue-900 dark:bg-blue-950 dark:text-blue-200' : 'bg-white group-hover:bg-gray-50 dark:bg-gray-800 dark:group-hover:bg-gray-700',
                    )}
                  >
                    {group.group}
                  </td>
                  <td className="px-3 py-1.5 text-right">{group.tests}</td>
                  {group.means.map((mean, at) => (
                    <td key={`mean-${at}`} title={comparedValue === 'cost' ? costTitle(mean) : undefined} className="px-3 py-1.5 text-right">
                      {format(mean)}
                    </td>
                  ))}
                  {group.ratios.map((ratio, at) =>
                    at === baselineIndex ? null : (
                      <td key={`ratio-${at}`} className={clsx('px-3 py-1.5 text-right', ratio !== null && ratioClass(ratio))}>
                        {ratio === null ? '-' : formatRatio(ratio)}
                      </td>
                    ),
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

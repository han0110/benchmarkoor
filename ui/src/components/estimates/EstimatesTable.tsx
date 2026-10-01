import { Fragment, useState } from 'react'
import { Link, useNavigate } from '@tanstack/react-router'
import clsx from 'clsx'
import { Tag } from 'lucide-react'
import { useRunIds } from '@/api/hooks/useEstimate'
import type { EstimateIndexEntry } from '@/api/types'
import { SortableHeader, SuiteCell } from '@/components/runs/RunsTable'
import type { SortColumn, SortDirection } from '@/components/runs/sortEntries'
import { Badge } from '@/components/shared/Badge'
import { ClientBadge } from '@/components/shared/ClientBadge'
import { formatRelativeTime, formatTimestampDate, formatTimestampTime } from '@/utils/date'
import { costTitle, formatCost } from '@/utils/estimate'
import { imageTag, meanCost, selectionBlocker, type EstimateSortColumn } from './estimateEntries'

export interface EstimatesTableProps {
  entries: EstimateIndexEntry[]
  sortBy: EstimateSortColumn
  sortDir: SortDirection
  onSortChange: (column: EstimateSortColumn, direction: SortDirection) => void
  /** The test count of each suite, keyed by suite hash. */
  suiteSizes: Map<string, number>
  showSuite?: boolean
  selectable?: boolean
  /** The picks in the order they were made. */
  selection?: EstimateIndexEntry[]
  onSelectionChange?: (entry: EstimateIndexEntry, selected: boolean) => void
}

export function EstimatesTable({ entries, sortBy, sortDir, onSortChange, suiteSizes, showSuite = false, selectable = false, selection = [], onSelectionChange }: EstimatesTableProps) {
  const [expandedRows, setExpandedRows] = useState<Set<string>>(new Set())
  const navigate = useNavigate()
  const runIds = useRunIds()

  const toggleExpanded = (estimateId: string) => {
    setExpandedRows((expanded) => {
      const next = new Set(expanded)
      if (next.has(estimateId)) next.delete(estimateId)
      else next.add(estimateId)
      return next
    })
  }

  // SortableHeader takes a run column but only compares it, so an estimate column passes with a cast.
  const header = (label: string, column: EstimateSortColumn, className?: string) => (
    <SortableHeader
      label={label}
      column={column as SortColumn}
      currentSort={sortBy as SortColumn}
      currentDirection={sortDir}
      onSort={() => onSortChange(column, column === sortBy && sortDir === 'desc' ? 'asc' : 'desc')}
      className={className}
    />
  )

  return (
    <div className="overflow-x-auto rounded-xs bg-white shadow-xs dark:bg-gray-800">
      <table className="min-w-full divide-y divide-gray-200 dark:divide-gray-700">
        <thead className="bg-gray-50 dark:bg-gray-900">
          <tr>
            {selectable && <th className="w-10 px-2 py-2 sm:px-3 sm:py-2" />}
            {header('Time', 'timestamp')}
            {header('Subject', 'subject')}
            {header('zkVM version', 'version')}
            {header('Image', 'image', 'hidden px-3 py-2 sm:table-cell sm:px-4 sm:py-2')}
            {showSuite && header('Suite', 'suite')}
            {header('F', 'failed', 'px-1.5 py-2 sm:px-2 sm:py-2')}
            {header('P', 'passed', 'px-1.5 py-2 sm:px-2 sm:py-2')}
            {header('T', 'total', 'px-1.5 py-2 sm:px-2 sm:py-2')}
            {header('Mean cost', 'cost', 'whitespace-nowrap px-3 py-2 sm:px-4 sm:py-2')}
            <th className="px-1.5 py-2 text-center text-xs/5 font-medium uppercase tracking-wider text-gray-500 sm:px-2 dark:text-gray-400">Run</th>
            <th className="w-8 px-1 py-2" />
          </tr>
        </thead>
        <tbody className="divide-y divide-gray-200 dark:divide-gray-700">
          {entries.map((entry) => {
            const selected = selection.some((picked) => picked.estimate_id === entry.estimate_id)
            const blocker = selectable ? selectionBlocker(entry, selection) : undefined
            const suiteSize = suiteSizes.get(entry.suite_hash)
            const cost = meanCost(entry)
            const hasFailures = entry.tests.tests_failed > 0
            const entryLabels = entry.metadata
              ? Object.entries(entry.metadata).filter(([key]) => !key.startsWith('github.') && key !== 'name')
              : []
            const time = (
              <>
                <span>{formatTimestampDate(entry.timestamp)}</span>
                <span className="text-xs/4 text-gray-400 dark:text-gray-500">{formatTimestampTime(entry.timestamp)}</span>
              </>
            )
            return (
              <Fragment key={entry.estimate_id}>
                <tr
                  onClick={() => {
                    if (!selectable) {
                      navigate({ to: '/estimates/$estimateId', params: { estimateId: entry.estimate_id } })
                    } else if (!blocker) {
                      onSelectionChange?.(entry, !selected)
                    }
                  }}
                  className={clsx(
                    'group relative transition-colors hover:z-20 hover:bg-gray-50 dark:hover:bg-gray-700/50',
                    !blocker && 'cursor-pointer',
                    hasFailures && 'bg-orange-50/50 dark:bg-orange-900/10',
                    selected && 'ring-2 ring-inset ring-blue-400 dark:ring-blue-500',
                  )}
                >
                  {selectable && (
                    <td className="relative z-10 whitespace-nowrap px-2 py-2 text-center sm:px-3 sm:py-4" title={blocker}>
                      <input
                        type="checkbox"
                        checked={selected}
                        disabled={!!blocker}
                        onChange={(e) => onSelectionChange?.(entry, e.target.checked)}
                        onClick={(e) => e.stopPropagation()}
                        className={clsx(
                          'size-4 rounded-xs border-gray-300 text-blue-600 focus:ring-blue-500 dark:border-gray-600',
                          blocker && 'cursor-not-allowed opacity-40',
                        )}
                      />
                    </td>
                  )}
                  <td className={clsx(
                    'whitespace-nowrap px-3 py-2 text-sm/6 text-gray-500 sm:px-4 sm:py-2.5 dark:text-gray-400 border-l-3',
                    hasFailures ? 'border-orange-400 dark:border-orange-500' : 'border-transparent',
                  )}>
                    {selectable ? (
                      <span className="flex flex-col" title={formatRelativeTime(entry.timestamp)}>{time}</span>
                    ) : (
                      <Link
                        to="/estimates/$estimateId"
                        params={{ estimateId: entry.estimate_id }}
                        onClick={(e) => e.stopPropagation()}
                        className="flex flex-col text-gray-500 dark:text-gray-400"
                        title={formatRelativeTime(entry.timestamp)}
                      >
                        {time}
                      </Link>
                    )}
                  </td>
                  <td className="whitespace-nowrap px-3 py-2 sm:px-4 sm:py-2.5">
                    <div className="flex items-center gap-2">
                      <span className="sm:hidden">
                        <ClientBadge client={entry.instance.client} metadata={entry.metadata} hideLabel />
                      </span>
                      <span className="hidden sm:inline-flex">
                        <ClientBadge client={entry.instance.client} metadata={entry.metadata} />
                      </span>
                    </div>
                  </td>
                  <td className="whitespace-nowrap px-3 py-2 text-sm/6 text-gray-500 sm:px-4 sm:py-2.5 dark:text-gray-400">
                    {entry.metadata?.zkvm_version ?? '-'}
                  </td>
                  <td className="hidden max-w-xs truncate px-3 py-2 font-mono text-sm/6 text-gray-500 sm:table-cell sm:px-4 sm:py-2.5 dark:text-gray-400">
                    <span title={entry.image}>{imageTag(entry.image)}</span>
                  </td>
                  {showSuite && (
                    <td className="relative z-10 whitespace-nowrap px-3 py-2 font-mono text-sm/6 sm:px-4 sm:py-2.5">
                      <SuiteCell suiteHash={entry.suite_hash} />
                    </td>
                  )}
                  <td className="whitespace-nowrap px-1.5 py-2 text-center sm:px-2 sm:py-2.5">
                    {hasFailures && <Badge variant="error">{entry.tests.tests_failed}</Badge>}
                  </td>
                  <td className="whitespace-nowrap px-1.5 py-2 text-center sm:px-2 sm:py-2.5">
                    <Badge variant="success">{entry.tests.tests_passed}</Badge>
                  </td>
                  <td className="whitespace-nowrap px-1.5 py-2 text-center sm:px-2 sm:py-2.5">
                    {suiteSize !== undefined && <Badge>{suiteSize}</Badge>}
                  </td>
                  <td className="whitespace-nowrap px-3 py-2 text-right text-sm/6 text-gray-500 sm:px-4 sm:py-2.5 dark:text-gray-400">
                    {cost === null ? '-' : <span title={costTitle(cost)}>{formatCost(cost)}</span>}
                  </td>
                  <td className="whitespace-nowrap px-1.5 py-2 text-center text-sm/6 sm:px-2 sm:py-2.5">
                    {runIds?.has(entry.estimate_id) && (
                      <Link
                        to="/runs/$runId"
                        params={{ runId: entry.estimate_id }}
                        onClick={(e) => e.stopPropagation()}
                        className="text-blue-600 hover:text-blue-800 hover:underline dark:text-blue-400 dark:hover:text-blue-300"
                      >
                        View
                      </Link>
                    )}
                  </td>
                  <td className="relative z-10 px-1 py-2 text-center">
                    {entryLabels.length > 0 && (
                      <div className="group/tag relative inline-block">
                        <button
                          onClick={(e) => { e.stopPropagation(); e.preventDefault(); toggleExpanded(entry.estimate_id) }}
                          className={clsx(
                            'rounded-xs p-0.5 transition-colors',
                            expandedRows.has(entry.estimate_id)
                              ? 'text-blue-600 dark:text-blue-400'
                              : 'text-gray-400 hover:text-gray-600 dark:text-gray-500 dark:hover:text-gray-300',
                          )}
                        >
                          <Tag className="size-3.5" />
                        </button>
                        <div className="pointer-events-none absolute right-0 top-full z-50 mt-1 hidden w-max max-w-xs rounded-sm bg-white px-3 py-2 text-xs/5 shadow-lg ring-1 ring-gray-200 group-hover/tag:block dark:bg-gray-800 dark:ring-gray-700">
                          <div className="flex flex-col gap-1.5">
                            <div className="text-gray-400 dark:text-gray-500">Instance ID: {entry.instance.id}</div>
                            <div className="flex flex-wrap gap-1">
                              {entryLabels.map(([key, value]) => (
                                <span key={key} className="inline-flex items-center gap-1 rounded-xs border border-blue-200 bg-blue-50 px-1.5 py-0.5 text-xs/4 font-medium text-blue-700 dark:border-blue-800 dark:bg-blue-900/30 dark:text-blue-300">
                                  <span className="font-semibold">{key}</span>={value}
                                </span>
                              ))}
                            </div>
                          </div>
                        </div>
                      </div>
                    )}
                  </td>
                </tr>
                {entryLabels.length > 0 && expandedRows.has(entry.estimate_id) && (
                  <tr>
                    <td colSpan={(selectable ? 1 : 0) + (showSuite ? 1 : 0) + 10} className="bg-gray-50/50 px-3 py-1.5 sm:px-4 dark:bg-gray-900/30">
                      <div className="flex flex-wrap items-center justify-end gap-1.5">
                        <span className="text-xs/4 text-gray-400 dark:text-gray-500">
                          ID: {entry.instance.id}
                        </span>
                        {entryLabels.map(([key, value]) => (
                          <span key={key} className="inline-flex items-center gap-1 rounded-xs border border-blue-200 bg-blue-50 px-1.5 py-0.5 text-xs/4 font-medium text-blue-700 dark:border-blue-800 dark:bg-blue-900/30 dark:text-blue-300">
                            <span className="font-semibold">{key}</span>
                            <span>=</span>
                            <span>{value}</span>
                          </span>
                        ))}
                      </div>
                    </td>
                  </tr>
                )}
              </Fragment>
            )
          })}
        </tbody>
      </table>
    </div>
  )
}

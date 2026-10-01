import { useMemo, useState } from 'react'
import clsx from 'clsx'
import { FlaskConical } from 'lucide-react'
import type { SuiteTest } from '@/api/types'
import { Pagination } from '@/components/shared/Pagination'
import { TestName } from '@/components/shared/TestName'
import { formatBytes, formatDurationMs } from '@/utils/format'
import { costTitle, deviationClass, formatCost, formatPercent, formatSignedDuration, formatSignedPercent, suiteOrder } from '@/utils/estimate'
import type { TestStatusFilter } from '../../TestsTable'
import { orDash } from '../utils/rows'
import type { EstimateRow, EstimateSortField, EstimateState } from '../types'

const PAGE_SIZE_OPTIONS = [20, 50, 100]

interface EstimateTableProps {
  /** The rows in the order the table prints them. */
  data: EstimateRow[]
  kinds: string[]
  /** Suite tests in canonical run order, which give the number of each test. */
  suiteTests?: SuiteTest[]
  state: EstimateState
  onUpdate: (updates: Partial<EstimateState>) => void
  onTestClick?: (testName: string) => void
  /** The page search, whose terms the chips of the names show as active. */
  searchQuery?: string
  onChipClick?: (term: string) => void
  /** Names the measured time, "Execution" or "Proving". */
  timeLabel: string
  /** Prints the measured, fitted, and error columns, which an estimate without block logs has nothing for. */
  hasTiming: boolean
  /** Prints the peak heap column, which only some servers report. */
  reportsHeap: boolean
  /** The run status the page keeps. Its buttons show only together with onStatusFilterChange. */
  statusFilter?: TestStatusFilter
  onStatusFilterChange?: (status: TestStatusFilter) => void
}

function SortIcon({ direction, active }: { direction: EstimateState['sortOrder']; active: boolean }) {
  return (
    <svg
      className={clsx('ml-1 inline-block size-3', active ? 'text-gray-700 dark:text-gray-300' : 'text-gray-400')}
      viewBox="0 0 12 12"
      fill="currentColor"
    >
      {direction === 'asc' ? <path d="M6 2L10 8H2L6 2Z" /> : <path d="M6 10L2 4H10L6 10Z" />}
    </svg>
  )
}

/** Prints a fit error signed in the color of its sign, or unsigned. A missing error prints as a dash. */
export function FitError({ error, signed }: { error: number | null; signed: boolean }) {
  if (error === null) return '-'
  return signed ? <span className={deviationClass(error)}>{formatSignedPercent(error)}</span> : formatPercent(Math.abs(error))
}

export function EstimateTable({ data, kinds, suiteTests, state, onUpdate, onTestClick, searchQuery, onChipClick, timeLabel, hasTiming, reportsHeap, statusFilter, onStatusFilterChange }: EstimateTableProps) {
  const [currentPage, setCurrentPage] = useState(1)
  const [pageSize, setPageSize] = useState(20)
  const { positions } = useMemo(() => suiteOrder(suiteTests), [suiteTests])

  const paginatedData = useMemo(() => {
    const startIndex = (currentPage - 1) * pageSize
    return data.slice(startIndex, startIndex + pageSize)
  }, [data, currentPage, pageSize])

  // Reset to page 1 when data changes and current page would be out of bounds
  const maxPage = Math.ceil(data.length / pageSize) || 1
  if (currentPage > maxPage) {
    setCurrentPage(1)
  }

  // A column sorts descending first, so the largest figures lead.
  const handleSort = (sortBy: EstimateSortField) => {
    onUpdate({ sortBy, sortOrder: state.sortBy === sortBy && state.sortOrder === 'desc' ? 'asc' : 'desc' })
    setCurrentPage(1)
  }

  const handlePageSizeChange = (newSize: number) => {
    setPageSize(newSize)
    setCurrentPage(1)
  }

  const header = (label: string, field: EstimateSortField, className = 'text-right') => {
    const isActive = state.sortBy === field
    return (
      <th
        key={field}
        onClick={() => handleSort(field)}
        className={clsx(
          'cursor-pointer select-none whitespace-nowrap px-4 py-3 text-left text-xs/5 font-medium uppercase tracking-wider text-gray-500 hover:text-gray-700 dark:text-gray-400 dark:hover:text-gray-300',
          className,
        )}
      >
        {label}
        <SortIcon direction={isActive ? state.sortOrder : 'asc'} active={isActive} />
      </th>
    )
  }

  const title = (
    <div className="flex flex-wrap items-center justify-between gap-4">
      <h2 className="flex items-center gap-2 text-lg/7 font-semibold text-gray-900 dark:text-gray-100">
        <FlaskConical className="size-5 text-gray-400 dark:text-gray-500" />
        Tests ({data.length})
      </h2>
      {statusFilter && onStatusFilterChange && (
        <div className="flex items-center gap-1 rounded-sm bg-gray-100 p-0.5 dark:bg-gray-700">
          {(['all', 'passed', 'failed'] as const).map((status) => (
            <button
              key={status}
              onClick={() => onStatusFilterChange(status)}
              className={clsx(
                'rounded-xs px-2 py-1 text-xs/5 font-medium capitalize transition-colors',
                statusFilter === status
                  ? 'bg-white text-gray-900 shadow-xs dark:bg-gray-600 dark:text-gray-100'
                  : 'text-gray-600 hover:text-gray-900 dark:text-gray-400 dark:hover:text-gray-100',
              )}
            >
              {status}
            </button>
          ))}
        </div>
      )}
    </div>
  )

  if (data.length === 0) {
    return (
      <div className="flex flex-col gap-4">
        {title}
        <div className="rounded-sm bg-white py-8 text-center text-sm text-gray-500 shadow-xs dark:bg-gray-800 dark:text-gray-400">
          No tests match the current filters.
        </div>
      </div>
    )
  }

  const paginationControls = (
    <div className="flex items-center justify-between">
      <div className="flex items-center gap-2">
        <span className="text-sm/6 text-gray-500 dark:text-gray-400">Show</span>
        <select
          value={pageSize}
          onChange={(e) => handlePageSizeChange(Number(e.target.value))}
          className="rounded-sm border border-gray-300 bg-white px-2 py-1 text-sm/6 focus:border-blue-500 focus:outline-hidden focus:ring-1 focus:ring-blue-500 dark:border-gray-600 dark:bg-gray-800 dark:text-gray-100"
        >
          {PAGE_SIZE_OPTIONS.map((size) => (
            <option key={size} value={size}>
              {size}
            </option>
          ))}
        </select>
        <span className="text-sm/6 text-gray-500 dark:text-gray-400">per page</span>
      </div>
      <Pagination currentPage={currentPage} totalPages={maxPage} onPageChange={setCurrentPage} />
    </div>
  )

  return (
    <div className="flex flex-col gap-4">
      {title}

      {paginationControls}

      <div className="overflow-x-auto rounded-sm bg-white shadow-xs dark:bg-gray-800">
        <table className="min-w-full divide-y divide-gray-200 dark:divide-gray-700">
          <thead className="bg-gray-50 dark:bg-gray-900">
            <tr>
              {header('#', 'order', 'w-12')}
              {header('Test', 'name', 'text-left')}
              {header('Cost', 'cost')}
              {kinds.map((kind) => header(kind, `kind:${kind}`))}
              {reportsHeap && header('Peak Heap', 'heap')}
              {hasTiming && header(`${timeLabel} Time`, 'time')}
              {hasTiming && header('Fitted Time', 'fitted')}
              {hasTiming && header('Error', 'error')}
            </tr>
          </thead>
          <tbody className="divide-y divide-gray-200 dark:divide-gray-700">
            {paginatedData.map((row) => (
              <tr
                key={row.testName}
                onClick={() => onTestClick?.(row.testName)}
                className={clsx('transition-colors hover:bg-gray-50 dark:hover:bg-gray-700/50', onTestClick && 'cursor-pointer')}
              >
                <td className="whitespace-nowrap px-4 py-3 text-sm/6 font-medium text-gray-500 dark:text-gray-400">{positions.get(row.testName) ?? '-'}</td>
                <td className="max-w-md px-4 py-3">
                  <TestName name={row.testName} onChipClick={onChipClick} activeQuery={searchQuery} className="text-sm/6 font-medium text-gray-900 dark:text-gray-100" />
                </td>
                <td title={costTitle(row.total)} className="whitespace-nowrap px-4 py-3 text-right text-sm/6 text-gray-500 dark:text-gray-400">
                  {formatCost(row.total)}
                </td>
                {kinds.map((kind, at) => (
                  <td key={kind} title={costTitle(row.costs[at])} className="whitespace-nowrap px-4 py-3 text-right text-sm/6 text-gray-500 dark:text-gray-400">
                    {formatCost(row.costs[at])}
                  </td>
                ))}
                {reportsHeap && (
                  <td className="whitespace-nowrap px-4 py-3 text-right text-sm/6 text-gray-500 dark:text-gray-400">
                    {orDash(row.peakHeapBytes, formatBytes)}
                  </td>
                )}
                {hasTiming && (
                  <>
                    <td className="whitespace-nowrap px-4 py-3 text-right text-sm/6 text-gray-500 dark:text-gray-400">
                      {orDash(row.timeMs, formatDurationMs)}
                    </td>
                    <td className="whitespace-nowrap px-4 py-3 text-right text-sm/6 text-gray-500 dark:text-gray-400">
                      {orDash(row.fittedMs, formatSignedDuration)}
                    </td>
                    <td className="whitespace-nowrap px-4 py-3 text-right text-sm/6 text-gray-500 dark:text-gray-400">
                      <FitError error={row.error} signed />
                    </td>
                  </>
                )}
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      {paginationControls}
    </div>
  )
}

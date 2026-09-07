import { useMemo, useState } from 'react'
import { formatDurationMs } from '@/utils/format'
import { deviationClass, formatCost, formatPercent, formatSignedDuration, formatSignedPercent } from '@/utils/estimate'
import { PageControls, SortHeader } from '../../block-logs-dashboard/components/BlockLogsTable'
import { CATEGORY_COLORS } from '../../block-logs-dashboard/utils/colors'
import type { EstimateRow, EstimateSortField, EstimateState } from '../types'

interface EstimateTableProps {
  /** The rows in the order the table prints them. */
  data: EstimateRow[]
  kinds: string[]
  state: EstimateState
  onUpdate: (updates: Partial<EstimateState>) => void
  onTestClick?: (testName: string) => void
  /** Names the measured time, "Execution" or "Proving". */
  timeLabel: string
  /** Prints the measured, fitted, and error columns, which a run without block logs has nothing for. */
  hasTiming: boolean
}

/** A figure the row lacks prints as a dash. */
const orDash = (value: number | null, format: (value: number) => string) => (value === null ? '-' : format(value))

export function EstimateTable({ data, kinds, state, onUpdate, onTestClick, timeLabel, hasTiming }: EstimateTableProps) {
  const [currentPage, setCurrentPage] = useState(1)
  const [pageSize, setPageSize] = useState(20)

  const paginatedData = useMemo(() => {
    const startIndex = (currentPage - 1) * pageSize
    return data.slice(startIndex, startIndex + pageSize)
  }, [data, currentPage, pageSize])

  // Reset to page 1 when data changes and current page would be out of bounds
  const maxPage = Math.ceil(data.length / pageSize) || 1
  if (currentPage > maxPage) {
    setCurrentPage(1)
  }

  const handleSort = (sortBy: EstimateSortField, sortOrder: EstimateState['sortOrder']) => {
    onUpdate({ sortBy, sortOrder })
    setCurrentPage(1)
  }

  const handlePageSizeChange = (newSize: number) => {
    setPageSize(newSize)
    setCurrentPage(1)
  }

  if (data.length === 0) {
    return (
      <div className="py-8 text-center text-sm text-gray-500 dark:text-gray-400">
        No tests match the current filters.
      </div>
    )
  }

  const header = (label: string, field: EstimateSortField) => (
    <th key={field} scope="col" className="px-3 py-3 text-right text-xs">
      <SortHeader label={label} field={field} currentSort={state.sortBy} currentOrder={state.sortOrder} onSort={handleSort} align="right" />
    </th>
  )

  const paginationControls = (
    <PageControls currentPage={currentPage} pageSize={pageSize} total={data.length} onPageChange={setCurrentPage} onPageSizeChange={handlePageSizeChange} />
  )

  return (
    <div className="flex flex-col">
      <div className="border-t border-gray-200 dark:border-gray-700">
        {paginationControls}
      </div>

      <div className="overflow-x-auto border-t border-gray-200 dark:border-gray-700">
        <table className="min-w-full divide-y divide-gray-200 dark:divide-gray-700">
          <thead className="bg-gray-50 dark:bg-gray-800/50">
            <tr>
              <th scope="col" className="sticky left-0 z-10 bg-gray-50 px-3 py-3 text-left text-xs dark:bg-gray-800/50">
                <SortHeader label="Test #" field="order" currentSort={state.sortBy} currentOrder={state.sortOrder} onSort={handleSort} />
              </th>
              <th scope="col" className="px-3 py-3 text-left text-xs">
                <SortHeader label="Category" field="category" currentSort={state.sortBy} currentOrder={state.sortOrder} onSort={handleSort} />
              </th>
              {header('Estimated Cost', 'cost')}
              {kinds.map((kind) => header(kind, `kind:${kind}`))}
              {hasTiming && header(`${timeLabel} Time`, 'time')}
              {hasTiming && header('Fitted Time', 'fitted')}
              {hasTiming && header(state.signedError ? 'Error' : '|Error|', 'error')}
            </tr>
          </thead>
          <tbody className="divide-y divide-gray-200 dark:divide-gray-700">
            {paginatedData.map((row) => (
              <tr
                key={row.testName}
                onClick={() => onTestClick?.(row.testName)}
                className={`hover:bg-gray-50 dark:hover:bg-gray-800/50 ${onTestClick ? 'cursor-pointer' : ''}`}
              >
                <td className="sticky left-0 z-10 bg-white px-3 py-2 text-sm text-gray-900 dark:bg-gray-800 dark:text-gray-100">
                  <span title={row.testName} className="cursor-help">
                    {row.testNumber}
                  </span>
                </td>
                <td className="px-3 py-2">
                  <span
                    className="inline-flex items-center rounded-full px-2 py-0.5 text-xs font-medium capitalize"
                    style={{
                      backgroundColor: `${CATEGORY_COLORS[row.category]}20`,
                      color: CATEGORY_COLORS[row.category],
                    }}
                  >
                    {row.category}
                  </span>
                </td>
                <td className="px-3 py-2 text-right font-mono text-sm text-gray-900 dark:text-gray-100">
                  {formatCost(row.total)}
                </td>
                {kinds.map((kind, at) => (
                  <td key={kind} className="px-3 py-2 text-right font-mono text-sm text-gray-600 dark:text-gray-400">
                    {state.costShare ? orDash(row.shares[at], formatPercent) : formatCost(row.costs[at])}
                  </td>
                ))}
                {hasTiming && (
                  <>
                    <td className="px-3 py-2 text-right font-mono text-sm text-gray-600 dark:text-gray-400">
                      {orDash(row.timeMs, formatDurationMs)}
                    </td>
                    <td className="px-3 py-2 text-right font-mono text-sm text-gray-600 dark:text-gray-400">
                      {orDash(row.fittedMs, formatSignedDuration)}
                    </td>
                    <td className="px-3 py-2 text-right font-mono text-sm text-gray-600 dark:text-gray-400">
                      {row.error === null ? '-' : state.signedError ? <span className={deviationClass(row.error)}>{formatSignedPercent(row.error)}</span> : formatPercent(Math.abs(row.error))}
                    </td>
                  </>
                )}
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      <div className="border-t border-gray-200 dark:border-gray-700">
        {paginationControls}
      </div>
    </div>
  )
}

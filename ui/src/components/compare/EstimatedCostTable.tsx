import { useMemo, useState } from 'react'
import clsx from 'clsx'
import { FlaskConical } from 'lucide-react'
import { EstimateBadge } from '@/components/estimates/EstimateCompareHeader'
import { PageControls, SortHeader } from '@/components/run-detail/block-logs-dashboard/components/BlockLogsTable'
import type { SortDirection } from '@/components/runs/sortEntries'
import { TestName } from '@/components/shared/TestName'
import { costTitle, formatRatio, formatSigned, ratioClass } from '@/utils/estimate'
import type { CompareRun, LabelMode } from './constants'
import { COMPARED_VALUES, appliedSort, comparedFigures, sortComparedTests, type ComparedSortField, type ComparedTest, type ComparedValue } from './estimateComparison'

interface EstimatedCostTableProps {
  runs: CompareRun[]
  /** The passed and failed tests the filter keeps, in suite order. */
  rows: ComparedTest[]
  comparedValue: ComparedValue
  labelMode: LabelMode
  baselineIndex: number
  /** The filter query, which marks the chips it pins. */
  searchQuery: string
  onChipClick: (term: string) => void
}

/** The sorts of an estimate column. The baseline column sorts by its value only. */
const FIGURES: { figure: 'value' | 'ratio' | 'delta'; label: string }[] = [
  { figure: 'value', label: 'Value' },
  { figure: 'ratio', label: 'Ratio' },
  { figure: 'delta', label: 'Delta' },
]

/** Every test that passed or failed in an estimate, with the value of each estimate and its ratio and delta to the baseline. */
export function EstimatedCostTable({ runs, rows, comparedValue, labelMode, baselineIndex, searchQuery, onChipClick }: EstimatedCostTableProps) {
  const [sort, setSort] = useState<{ sortBy: ComparedSortField; sortDir: SortDirection } | null>(null)
  const [currentPage, setCurrentPage] = useState(1)
  const [pageSize, setPageSize] = useState(20)
  const { sortBy, sortDir } = appliedSort(sort, baselineIndex)

  const sorted = useMemo(() => sortComparedTests(rows, sortBy, sortDir, baselineIndex), [rows, sortBy, sortDir, baselineIndex])
  const pageRows = sorted.slice((currentPage - 1) * pageSize, currentPage * pageSize)

  const maxPage = Math.ceil(sorted.length / pageSize) || 1
  if (currentPage > maxPage) {
    setCurrentPage(1)
  }

  const onSort = (field: ComparedSortField, order: SortDirection) => {
    setSort({ sortBy: field, sortDir: order })
    setCurrentPage(1)
  }

  const onPageSizeChange = (size: number) => {
    setPageSize(size)
    setCurrentPage(1)
  }

  const { format } = COMPARED_VALUES[comparedValue]

  const title = (
    <h2 className="flex items-center gap-2 text-lg/7 font-semibold text-gray-900 dark:text-gray-100">
      <FlaskConical className="size-5 text-gray-400 dark:text-gray-500" />
      Tests ({sorted.length})
    </h2>
  )

  if (sorted.length === 0) {
    return (
      <div className="flex flex-col gap-4">
        {title}
        <div className="rounded-sm bg-white py-8 text-center text-sm text-gray-500 shadow-xs dark:bg-gray-800 dark:text-gray-400">
          No tests match the current filters.
        </div>
      </div>
    )
  }

  const pageControls = (
    <PageControls currentPage={currentPage} pageSize={pageSize} total={sorted.length} onPageChange={setCurrentPage} onPageSizeChange={onPageSizeChange} />
  )

  return (
    <div className="flex flex-col gap-4">
      {title}

      <div className="overflow-hidden rounded-sm bg-white shadow-xs dark:bg-gray-800">
        {pageControls}

        <div className="max-h-[70vh] overflow-auto border-y border-gray-200 dark:border-gray-700">
          <table className="min-w-full divide-y divide-gray-200 dark:divide-gray-700">
            <thead className="sticky top-0 z-10 bg-gray-50 dark:bg-gray-900">
              <tr>
                <th scope="col" className="sticky left-0 z-20 bg-gray-50 px-3 py-2 text-left align-bottom text-xs/5 dark:bg-gray-900">
                  <SortHeader label="Test" field="order" currentSort={sortBy} currentOrder={sortDir} onSort={onSort} />
                </th>
                {runs.map((run, at) => (
                  <th key={run.runId} scope="col" className="px-3 py-2 text-right text-xs/5">
                    <span className="flex flex-col items-end gap-1">
                      <EstimateBadge run={run} labelMode={labelMode} />
                      <span className="flex gap-2">
                        {(at === baselineIndex ? FIGURES.slice(0, 1) : FIGURES).map(({ figure, label }) => (
                          <SortHeader key={figure} label={label} field={`${figure}:${at}`} currentSort={sortBy} currentOrder={sortDir} onSort={onSort} />
                        ))}
                      </span>
                    </span>
                  </th>
                ))}
              </tr>
            </thead>
            <tbody className="divide-y divide-gray-200 dark:divide-gray-700">
              {pageRows.map((row) => (
                <tr key={row.testName} className="group hover:bg-gray-50 dark:hover:bg-gray-700">
                  <td className="sticky left-0 bg-white px-3 py-1.5 group-hover:bg-gray-50 dark:bg-gray-800 dark:group-hover:bg-gray-700">
                    <div className="flex w-40 items-baseline gap-2 sm:w-auto sm:min-w-96 sm:max-w-xl">
                      <span className="shrink-0 font-mono text-xs/5 text-gray-400 dark:text-gray-500">#{row.testNumber}</span>
                      <TestName name={row.testName} onChipClick={onChipClick} activeQuery={searchQuery} />
                    </div>
                  </td>
                  {runs.map((run, at) => {
                    const error = row.errors[at]
                    const figures = comparedFigures(row, at, baselineIndex)
                    return (
                      <td key={run.runId} className="whitespace-nowrap px-3 py-1.5 text-right font-mono text-sm/6 text-gray-900 dark:text-gray-100">
                        {error !== undefined ? (
                          <span title={error} className="cursor-help text-red-600 dark:text-red-400">
                            failed
                          </span>
                        ) : figures.value === null ? (
                          <span className="text-gray-400 dark:text-gray-500">-</span>
                        ) : (
                          <>
                            <div title={comparedValue === 'cost' ? costTitle(figures.value) : undefined}>{format(figures.value)}</div>
                            {at !== baselineIndex && figures.ratio !== null && figures.delta !== null && (
                              <div className={clsx('text-xs/4', ratioClass(figures.ratio))}>
                                {formatRatio(figures.ratio)} {formatSigned(figures.delta, format)}
                              </div>
                            )}
                          </>
                        )}
                      </td>
                    )
                  })}
                </tr>
              ))}
            </tbody>
          </table>
        </div>

        {pageControls}
      </div>
    </div>
  )
}

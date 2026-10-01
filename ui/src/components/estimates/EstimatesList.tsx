import { useMemo, useState, type ReactNode } from 'react'
import { useEstimateIndex } from '@/api/hooks/useEstimate'
import { useSuite } from '@/api/hooks/useSuite'
import type { SortDirection } from '@/components/runs/sortEntries'
import { Pagination } from '@/components/shared/Pagination'
import { Spinner } from '@/components/shared/Spinner'
import { EstimatesTable, type EstimatesTableProps } from './EstimatesTable'
import { sortEstimates, type EstimateSortColumn } from './estimateEntries'

const PAGE_SIZE_OPTIONS = [50, 100, 200] as const
const DEFAULT_PAGE_SIZE = 100

interface EstimatesListProps extends EstimatesTableProps {
  /** The controls in front of the page size select. */
  actions?: ReactNode
}

/** The estimates table with the page size select and the pager above and below it. */
export function EstimatesList({ actions, entries, ...tableProps }: EstimatesListProps) {
  const [page, setPage] = useState(1)
  const [pageSize, setPageSize] = useState(DEFAULT_PAGE_SIZE)
  // A new list, after a filter or a sort, starts at the first page.
  const [previousEntries, setPreviousEntries] = useState(entries)
  if (entries !== previousEntries) {
    setPreviousEntries(entries)
    setPage(1)
  }

  const handlePageSizeChange = (newSize: number) => {
    setPageSize(newSize)
    setPage(1)
  }

  const pageSizeControl = (
    <>
      <span className="text-sm/6 text-gray-500 dark:text-gray-400">Show</span>
      <select
        value={pageSize}
        onChange={(e) => handlePageSizeChange(Number(e.target.value))}
        className="rounded-xs border border-gray-300 bg-white px-2 py-1 text-sm/6 focus:border-blue-500 focus:outline-hidden focus:ring-1 focus:ring-blue-500 dark:border-gray-600 dark:bg-gray-800 dark:text-gray-100"
      >
        {PAGE_SIZE_OPTIONS.map((size) => (
          <option key={size} value={size}>
            {size}
          </option>
        ))}
      </select>
      <span className="hidden text-sm/6 text-gray-500 sm:inline dark:text-gray-400">per page</span>
    </>
  )
  const pagination = <Pagination currentPage={page} totalPages={Math.ceil(entries.length / pageSize)} onPageChange={setPage} />

  return (
    <div className="flex flex-col gap-4">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div className="flex items-center gap-3">
          {actions}
          {pageSizeControl}
        </div>
        {pagination}
      </div>
      <EstimatesTable entries={entries.slice((page - 1) * pageSize, page * pageSize)} {...tableProps} />
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div className="flex items-center gap-2">
          {pageSizeControl}
        </div>
        {pagination}
      </div>
    </div>
  )
}

/** The entries of the estimate index with the suite hash. */
function useSuiteEstimates(suiteHash: string) {
  const { data: index, isLoading } = useEstimateIndex()
  const entries = useMemo(() => index?.entries.filter((entry) => entry.suite_hash === suiteHash) ?? [], [index, suiteHash])
  return { entries, isLoading }
}

/** The number of estimates of the suite. */
export function SuiteEstimateCount({ suiteHash }: { suiteHash: string }) {
  return useSuiteEstimates(suiteHash).entries.length
}

/** The estimates of the suite in a sortable and paged table. */
export function SuiteEstimates({ suiteHash }: { suiteHash: string }) {
  const { entries, isLoading } = useSuiteEstimates(suiteHash)
  const { data: suite } = useSuite(suiteHash)
  const [sortBy, setSortBy] = useState<EstimateSortColumn>('timestamp')
  const [sortDir, setSortDir] = useState<SortDirection>('desc')
  const suiteSizes = useMemo(() => new Map<string, number>(suite ? [[suiteHash, suite.tests.length]] : []), [suite, suiteHash])
  const sortedEntries = useMemo(() => sortEstimates(entries, sortBy, sortDir, suiteSizes), [entries, sortBy, sortDir, suiteSizes])

  if (isLoading) {
    return (
      <div className="flex justify-center py-8">
        <Spinner size="md" />
      </div>
    )
  }

  if (entries.length === 0) {
    return (
      <p className="py-8 text-center text-sm/6 text-gray-500 dark:text-gray-400">
        No estimates found for this suite.
      </p>
    )
  }

  return (
    <EstimatesList
      entries={sortedEntries}
      sortBy={sortBy}
      sortDir={sortDir}
      onSortChange={(column, direction) => {
        setSortBy(column)
        setSortDir(direction)
      }}
      suiteSizes={suiteSizes}
    />
  )
}

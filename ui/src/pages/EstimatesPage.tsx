import { useNavigate, useSearch } from '@tanstack/react-router'
import { SquareStack } from 'lucide-react'
import { useMemo, useState } from 'react'
import { useQueries, type UseQueryResult } from '@tanstack/react-query'
import { useEstimateIndex } from '@/api/hooks/useEstimate'
import { fetchData } from '@/api/client'
import type { EstimateIndexEntry, SuiteInfo } from '@/api/types'
import { EstimatesList } from '@/components/estimates/EstimatesList'
import { availableLabels, sortEstimates, spansEreTags, spansSuites, type EstimateSortColumn } from '@/components/estimates/estimateEntries'
import { FilterDropdown } from '@/components/runs/RunFilters'
import { LabelFilters } from '@/components/runs/LabelFilters'
import { parseLabelFilters, serializeLabelFilters } from '@/components/runs/labelFilterUtils'
import type { SortDirection } from '@/components/runs/sortEntries'
import { JDenticon } from '@/components/shared/JDenticon'
import { LoadingState } from '@/components/shared/Spinner'
import { ErrorState } from '@/components/shared/ErrorState'
import { EmptyState } from '@/components/shared/EmptyState'
import { MAX_COMPARE_RUNS, MIN_COMPARE_RUNS } from '@/components/compare/constants'

interface EstimatesSearch {
  suite?: string
  labels?: string
  sortBy?: EstimateSortColumn
  sortDir?: SortDirection
}

/** Module scoped, so the list keeps its identity while the summaries stay the same. */
const combineSuiteSummaries = (results: UseQueryResult<SuiteInfo | null>[]) => results.map((result) => result.data)

export function EstimatesPage() {
  const navigate = useNavigate()
  const search = useSearch({ from: '/estimates' }) as EstimatesSearch
  const { suite, labels, sortBy = 'timestamp', sortDir = 'desc' } = search
  const labelFilters = useMemo(() => parseLabelFilters(labels), [labels])
  const { data: index, isLoading, error, refetch } = useEstimateIndex()
  const [compareMode, setCompareMode] = useState(false)
  const [selection, setSelection] = useState<EstimateIndexEntry[]>([])

  const entries = index?.entries
  // A failed discovery path can hold estimates, so the page names it and does not show the list as complete.
  const failure = index?.failedPaths.length ? `Failed to load the estimates of ${index.failedPaths.join(', ')}.` : undefined
  const suiteHashes = useMemo(() => [...new Set(entries?.map((entry) => entry.suite_hash))].sort(), [entries])

  const suiteSummaries = useQueries({
    queries: suiteHashes.map((hash) => ({
      queryKey: ['suite', hash],
      queryFn: async () => {
        const { data } = await fetchData<SuiteInfo>(`suites/${hash}/summary.json`, { cacheBustInterval: 3600 })
        return data
      },
      staleTime: Infinity,
    })),
    combine: combineSuiteSummaries,
  })

  const suiteSizes = useMemo(() => {
    const sizes = new Map<string, number>()
    suiteHashes.forEach((hash, at) => {
      const summary = suiteSummaries[at]
      if (summary) sizes.set(hash, summary.tests.length)
    })
    return sizes
  }, [suiteHashes, suiteSummaries])

  const labelKeys = useMemo(() => availableLabels(entries ?? []), [entries])

  const sortedEntries = useMemo(() => {
    const filteredEntries = (entries ?? []).filter((entry) => {
      if (suite && entry.suite_hash !== suite) return false
      for (const [key, allowedValues] of labelFilters) {
        const actual = entry.metadata?.[key]
        if (!actual || !allowedValues.has(actual)) return false
      }
      return true
    })
    return sortEstimates(filteredEntries, sortBy, sortDir, suiteSizes)
  }, [entries, suite, labelFilters, sortBy, sortDir, suiteSizes])

  if (isLoading) {
    return <LoadingState message="Loading estimates..." />
  }

  if (error) {
    return <ErrorState message={error.message} retry={() => refetch()} />
  }

  if (!entries || entries.length === 0) {
    return failure ? <ErrorState message={failure} retry={() => refetch()} /> : <EmptyState title="No estimates found" message="No estimates have been recorded yet." />
  }

  const handleSearchChange = (changes: EstimatesSearch) => {
    navigate({ to: '/estimates', search: { ...search, ...changes } })
  }

  const handleSelectionChange = (entry: EstimateIndexEntry, selected: boolean) => {
    setSelection((picks) => (selected ? [...picks, entry] : picks.filter((picked) => picked.estimate_id !== entry.estimate_id)))
  }

  const handleExitCompareMode = () => {
    setCompareMode(false)
    setSelection([])
  }

  const suiteOptions = [
    { value: '' as const, label: 'All suites' },
    ...suiteHashes.map((hash, at) => {
      const name = suiteSummaries[at]?.metadata?.labels?.name
      return { value: hash, label: name ? `${name} (${hash.slice(0, 4)})` : hash, icon: <JDenticon value={hash} size={16} /> }
    }),
  ]

  return (
    <div className="flex flex-col gap-6">
      <h1 className="text-2xl/8 font-bold text-gray-900 dark:text-gray-100">Estimates ({sortedEntries.length})</h1>
      {failure && <p className="text-sm/6 text-yellow-600 dark:text-yellow-400">{failure}</p>}

      <div className="flex flex-col gap-3">
        <div className="flex flex-wrap items-center gap-4">
          <FilterDropdown
            label="Suite"
            value={suite ?? ''}
            onChange={(value) => handleSearchChange({ suite: value || undefined })}
            options={suiteOptions}
            allLabel="All suites"
            width="w-44"
          />
        </div>
        <LabelFilters
          entries={[]}
          filters={labelFilters}
          onChange={(filters) => handleSearchChange({ labels: serializeLabelFilters(filters) })}
          availableLabels={labelKeys}
        />
      </div>

      {sortedEntries.length === 0 ? (
        <EmptyState title="No matching estimates" message="No estimates match your filters" />
      ) : (
        <EstimatesList
          actions={
            <button
              onClick={() => compareMode ? handleExitCompareMode() : setCompareMode(true)}
              className={`flex cursor-pointer items-center justify-center rounded-xs p-1.5 shadow-xs ring-1 ring-inset transition-colors ${
                compareMode
                  ? 'bg-blue-600 text-white ring-blue-600 hover:bg-blue-700 hover:ring-blue-700'
                  : 'bg-white text-gray-500 ring-gray-300 hover:bg-gray-50 hover:text-gray-700 dark:bg-gray-800 dark:text-gray-400 dark:ring-gray-600 dark:hover:bg-gray-700 dark:hover:text-gray-200'
              }`}
              title="Compare"
            >
              <SquareStack className="size-4" />
            </button>
          }
          entries={sortedEntries}
          sortBy={sortBy}
          sortDir={sortDir}
          onSortChange={(column, direction) => handleSearchChange({ sortBy: column, sortDir: direction })}
          suiteSizes={suiteSizes}
          showSuite
          selectable={compareMode}
          selection={selection}
          onSelectionChange={handleSelectionChange}
        />
      )}

      {compareMode && (
        <div className="fixed inset-x-0 bottom-0 z-50 border-t border-gray-200 bg-white px-6 py-3 shadow-sm dark:border-gray-700 dark:bg-gray-800">
          <div className="mx-auto flex max-w-7xl items-center justify-between">
            <div className="flex items-center gap-3">
              <span className="text-sm/6 font-medium text-gray-900 dark:text-gray-100">
                {selection.length} of {MAX_COMPARE_RUNS} selected
              </span>
              {spansSuites(selection) && (
                <span className="text-xs/5 text-yellow-600 dark:text-yellow-400">
                  Different suites, only shared tests are compared
                </span>
              )}
              {spansEreTags(selection) && (
                <span className="text-xs/5 text-yellow-600 dark:text-yellow-400">
                  Different ere tags, costs come from different ere versions
                </span>
              )}
            </div>
            <div className="flex items-center gap-2">
              <button
                onClick={handleExitCompareMode}
                className="rounded-sm px-3 py-1.5 text-sm/6 font-medium text-gray-700 hover:bg-gray-100 dark:text-gray-300 dark:hover:bg-gray-700"
              >
                Cancel
              </button>
              <button
                disabled={selection.length < MIN_COMPARE_RUNS}
                onClick={() => navigate({ to: '/estimates/compare', search: { estimates: selection.map((picked) => picked.estimate_id).join(',') } })}
                className="rounded-sm bg-blue-600 px-4 py-1.5 text-sm/6 font-medium text-white hover:bg-blue-700 disabled:cursor-not-allowed disabled:opacity-50"
              >
                Compare
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  )
}

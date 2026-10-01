import { useMemo } from 'react'
import { Link, useNavigate, useParams, useSearch } from '@tanstack/react-router'
import { useQuery } from '@tanstack/react-query'
import { Download } from 'lucide-react'
import { fetchHead } from '@/api/client'
import { useBlockLogs } from '@/api/hooks/useBlockLogs'
import { useEstimate, useRunIds } from '@/api/hooks/useEstimate'
import { useRunConfig } from '@/api/hooks/useRunConfig'
import { useRunResult } from '@/api/hooks/useRunResult'
import { useSuite } from '@/api/hooks/useSuite'
import { CrossLink } from '@/components/estimates/CrossLink'
import { EstimateConfiguration } from '@/components/estimates/EstimateConfiguration'
import { DimensionInsights } from '@/components/run-detail/DimensionInsights'
import { EstimateDashboard } from '@/components/run-detail/estimate-dashboard'
import { MetadataLabels } from '@/components/run-detail/MetadataLabels'
import { useStatusFilter } from '@/components/run-detail/remoteMetricsChart'
import { RunTestDetailModal, TEST_MODAL_TABS, type TestModalTab } from '@/components/run-detail/TestHeatmap'
import type { TestStatusFilter } from '@/components/run-detail/TestsTable'
import { ClientStat } from '@/components/shared/ClientStat'
import { ErrorState } from '@/components/shared/ErrorState'
import { FacetPanel } from '@/components/shared/FacetPanel'
import { FilterInput } from '@/components/shared/FilterInput'
import { JDenticon } from '@/components/shared/JDenticon'
import { LoadingState } from '@/components/shared/Spinner'
import { getNavigableDataUrl, loadRuntimeConfig } from '@/config/runtime'
import { isProvingRun } from '@/utils/blockLogs'
import { formatTimestamp } from '@/utils/date'
import { TEST_FILTER_HINT, toggleSearchTerm } from '@/utils/eestNameFilter'
import { costTotal, formatCost, keptTests } from '@/utils/estimate'
import { formatBytes } from '@/utils/format'

export function EstimateDetailPage() {
  const { estimateId } = useParams({ from: '/estimates/$estimateId' })
  const navigate = useNavigate()
  const { q = '', status = 'all', testModal, testStep, testExec } = useSearch({ from: '/estimates/$estimateId' }) as { q?: string; status?: TestStatusFilter; testModal?: string; testStep?: string; testExec?: string }
  const activeStepTab = TEST_MODAL_TABS.find((tab) => tab === testStep)
  const expandedExecRows = testExec ? new Set(testExec.split(',').map(Number).filter((n) => !isNaN(n))) : undefined
  const { data: estimate, isLoading, error, refetch } = useEstimate(estimateId)
  const { data: suite } = useSuite(estimate?.suite_hash)
  // A run links to the estimate of the same name.
  const runIds = useRunIds()
  const hasRun = !!runIds?.has(estimateId)
  const { data: config } = useRunConfig(estimateId, hasRun)
  const { data: result } = useRunResult(estimateId, hasRun)
  const { data: blockLogs } = useBlockLogs(hasRun ? estimateId : '')
  const includeTest = useStatusFilter(result?.tests, status)
  const artifactPath = `estimates/${estimateId}/result.estimate.json`
  const { data: runtimeConfig } = useQuery({
    queryKey: ['runtime-config'],
    queryFn: loadRuntimeConfig,
    staleTime: Infinity,
  })
  // The HEAD request waits for the estimate. The local and S3 modes find the path through the estimate index, which the estimate query loads.
  const { data: artifactHead, isLoading: artifactHeadLoading } = useQuery({
    queryKey: ['estimate', estimateId, 'artifact-head'],
    queryFn: () => fetchHead(artifactPath),
    enabled: !!estimate,
  })
  // The dimension breakdown reads the estimated tests the page filters keep, each at its total cost.
  const metric = useMemo(() => {
    const tests = estimate?.tests ?? {}
    const samples = keptTests(Object.keys(tests), { searchQuery: q, includeTest }).map((name) => ({ name, value: costTotal(tests[name].cost) }))
    return { samples, format: formatCost, label: 'estimated cost' }
  }, [estimate, q, includeTest])

  const updateSearch = (updates: Record<string, unknown>) => {
    navigate({ to: '.', search: (previous: Record<string, unknown>) => ({ ...previous, ...updates }) })
  }
  const handleSearchChange = (query: string) => updateSearch({ q: query || undefined })
  const handleSearchTermToggle = (term: string) => handleSearchChange(toggleSearchTerm(q, term))
  // The status filter reads the run result, so the control waits for it.
  const handleStatusFilterChange = result ? (value: TestStatusFilter) => updateSearch({ status: value !== 'all' ? value : undefined }) : undefined
  const handleTestModalChange = (testName: string | undefined) => updateSearch({ testModal: testName, testStep: undefined, testExec: undefined })
  const handleStepTabChange = (tab: TestModalTab) => updateSearch({ testStep: tab !== 'test' ? tab : undefined, testExec: undefined })
  const handleExpandedExecRowsChange = (rows: Set<number>) => updateSearch({ testExec: rows.size > 0 ? [...rows].sort((a, b) => a - b).join(',') : undefined })

  if (isLoading) {
    return <LoadingState message="Loading estimate..." />
  }

  if (error) {
    return <ErrorState message={error.message} retry={() => refetch()} />
  }

  if (!estimate) {
    return <ErrorState title="Estimate not found" message={estimateId} />
  }

  const artifactUrl = runtimeConfig && getNavigableDataUrl(artifactPath, runtimeConfig)
  const failedTests = Object.keys(estimate.failures ?? {}).length

  return (
    <div className="flex flex-col gap-6">
      <div className="flex flex-wrap items-center gap-x-2 gap-y-1 text-sm/6 text-gray-500 dark:text-gray-400">
        <div className="flex min-w-0 items-center gap-2">
          <Link to="/suites" className="shrink-0 hover:text-gray-700 dark:hover:text-gray-300">
            Suites
          </Link>
          <span>/</span>
          <Link
            to="/suites/$suiteHash"
            params={{ suiteHash: estimate.suite_hash }}
            className={`flex min-w-0 items-center gap-1.5 hover:text-gray-700 dark:hover:text-gray-300${suite?.metadata?.labels?.name ? '' : ' font-mono'}`}
          >
            <JDenticon value={estimate.suite_hash} size={16} className="shrink-0 rounded-xs" />
            <span className="truncate">{suite?.metadata?.labels?.name ?? estimate.suite_hash}</span>
          </Link>
          <span>/</span>
          <Link
            to="/suites/$suiteHash"
            params={{ suiteHash: estimate.suite_hash }}
            search={{ tab: 'estimates' }}
            className="shrink-0 hover:text-gray-700 dark:hover:text-gray-300"
          >
            estimates
          </Link>
          <span>/</span>
          <span className="truncate text-gray-900 dark:text-gray-100">{estimateId}</span>
          <CrossLink id={estimateId} target="run" />
        </div>
        <div className="flex items-center gap-2 sm:ml-auto">
          <a href={artifactUrl} target="_blank" rel="noreferrer" className="hover:text-gray-700 dark:hover:text-gray-300">
            result.estimate.json
          </a>
          <span className="text-xs text-gray-400 dark:text-gray-500">
            {artifactHeadLoading ? (
              <span className="inline-block size-3 animate-pulse rounded-full bg-gray-200 dark:bg-gray-600" />
            ) : artifactHead?.size != null ? (
              `(${formatBytes(artifactHead.size)})`
            ) : null}
          </span>
          <a
            href={artifactUrl}
            download="result.estimate.json"
            className="text-blue-600 hover:text-blue-700 dark:text-blue-400 dark:hover:text-blue-300"
            title="Download result.estimate.json"
          >
            <Download className="size-4" />
          </a>
        </div>
      </div>

      <div className="grid grid-cols-2 gap-4 sm:grid-cols-5">
        <ClientStat client={estimate.instance.client} runId={estimate.instance.id} />
        <div className="rounded-sm bg-white p-4 shadow-xs dark:bg-gray-800">
          <p className="text-sm/6 font-medium text-gray-500 dark:text-gray-400">Tests</p>
          <p className="mt-1 flex items-center gap-2 text-2xl/8 font-semibold">
            <span className="text-gray-900 dark:text-gray-100">{suite?.tests.length ?? '-'}</span>
            <span className="text-gray-400 dark:text-gray-500">/</span>
            <span className="text-green-600 dark:text-green-400">{Object.keys(estimate.tests).length}</span>
            {failedTests > 0 && (
              <>
                <span className="text-gray-400 dark:text-gray-500">/</span>
                <span className="text-red-600 dark:text-red-400">{failedTests}</span>
              </>
            )}
          </p>
          <p className="mt-2 text-xs/5 text-gray-500 dark:text-gray-400">
            Started at
          </p>
          <p className="text-xs/5 text-gray-900 dark:text-gray-100">
            {formatTimestamp(estimate.timestamp)}
          </p>
        </div>
      </div>

      <MetadataLabels labels={estimate.metadata.labels} />

      <EstimateConfiguration estimate={estimate} />

      <div className="sticky top-0 z-30 -mx-4 flex items-center gap-4 border-b border-gray-200 bg-white/95 px-4 py-2 backdrop-blur-sm dark:border-gray-700 dark:bg-gray-900/95">
        <FilterInput
          placeholder="Search... or e.g. opcode:ORIGIN file:arithmetic"
          title={TEST_FILTER_HINT}
          value={q}
          onValueChange={handleSearchChange}
          className="min-w-0 flex-1 rounded-xs border border-gray-300 bg-white px-3 py-1.5 text-sm/6 placeholder-gray-400 focus:border-blue-500 focus:outline-hidden focus:ring-1 focus:ring-blue-500 dark:border-gray-600 dark:bg-gray-700 dark:text-gray-100 dark:placeholder-gray-500"
        />
      </div>

      <FacetPanel testNames={[...Object.keys(estimate.tests), ...Object.keys(estimate.failures ?? {})]} query={q} onToggle={handleSearchTermToggle} />
      {Object.keys(estimate.tests).length > 0 && <DimensionInsights metric={metric} query={q} onToggle={handleSearchTermToggle} onTestClick={handleTestModalChange} />}

      {/* The block logs wait for the run config, which says whether they time proving or execution. */}
      <EstimateDashboard
        estimate={estimate}
        blockLogs={config ? blockLogs : null}
        isProving={isProvingRun(config)}
        suiteTests={suite?.tests}
        searchQuery={q}
        includeTest={includeTest}
        statusFilter={status}
        onStatusFilterChange={handleStatusFilterChange}
        onSearchTermToggle={handleSearchTermToggle}
        onTestClick={handleTestModalChange}
      />

      {/* The modal waits until the run index says whether a run exists. */}
      {runIds && (
        <RunTestDetailModal
          tests={result?.tests ?? {}}
          suiteTests={suite?.tests}
          runId={hasRun ? estimateId : ''}
          suiteHash={config?.suite_hash}
          selectedTest={testModal}
          searchQuery={q}
          postTestRPCCalls={config?.instance.post_test_rpc_calls}
          onSelectedTestChange={handleTestModalChange}
          onSearchChange={handleSearchChange}
          activeStepTab={activeStepTab}
          onActiveStepTabChange={handleStepTabChange}
          expandedExecRows={expandedExecRows}
          onExpandedExecRowsChange={handleExpandedExecRowsChange}
        />
      )}
    </div>
  )
}

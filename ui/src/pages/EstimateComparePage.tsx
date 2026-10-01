import { useMemo, useRef, useTransition } from 'react'
import clsx from 'clsx'
import { Link, useNavigate, useSearch } from '@tanstack/react-router'
import type { RunEstimate } from '@/api/types'
import { useEstimates } from '@/api/hooks/useEstimate'
import { useSuite } from '@/api/hooks/useSuite'
import { EstimatedCostChart } from '@/components/compare/EstimatedCostChart'
import { EstimatedCostComposition } from '@/components/compare/EstimatedCostComposition'
import { EstimatedCostDimensions } from '@/components/compare/EstimatedCostDimensions'
import { EstimatedCostSummary } from '@/components/compare/EstimatedCostSummary'
import { EstimatedCostTable } from '@/components/compare/EstimatedCostTable'
import { StickyRunBar } from '@/components/compare/StickyRunBar'
import { MAX_COMPARE_RUNS, MIN_COMPARE_RUNS, buildLabelModeOptions, type LabelMode } from '@/components/compare/constants'
import { COMPARED_VALUES, comparedTests, sharedTests, type ComparedValue } from '@/components/compare/estimateComparison'
import { EstimateCompareHeader } from '@/components/estimates/EstimateCompareHeader'
import { estimateCompareRun, imageTag } from '@/components/estimates/estimateEntries'
import { EmptyState } from '@/components/shared/EmptyState'
import { ErrorState } from '@/components/shared/ErrorState'
import { FilterInput } from '@/components/shared/FilterInput'
import { SegmentedControl } from '@/components/shared/SegmentedControl'
import { LoadingState } from '@/components/shared/Spinner'
import { compileQuery, toggleSearchTerm, TEST_FILTER_HINT } from '@/utils/eestNameFilter'
import { reportsHeap, sameZkvm } from '@/utils/estimate'

/** The search of the page. The router parses a numeric value as a number, so a value arrives as either. */
interface EstimateCompareSearch {
  estimates?: string | number
  baseline?: string | number
  labels?: string | number
  filter?: string | number
  filterRegex?: string | number
  metric?: string | number
}

/** The regular expression of the filter, null where the pattern is invalid. */
function filterPattern(query: string): RegExp | null {
  try {
    return new RegExp(query, 'i')
  } catch {
    return null
  }
}

export function EstimateComparePage() {
  const navigate = useNavigate()
  const search = useSearch({ from: '/estimates/compare' }) as EstimateCompareSearch

  const estimateIds = useMemo(
    () => [...new Set(String(search.estimates ?? '').split(',').map((id) => id.trim()).filter(Boolean))].slice(0, MAX_COMPARE_RUNS),
    [search.estimates],
  )
  const { estimates, isPending, error } = useEstimates(estimateIds)

  if (estimateIds.length < MIN_COMPARE_RUNS) {
    return <ErrorState message={`At least ${MIN_COMPARE_RUNS} estimate IDs are required. Use /estimates/compare?estimates=id1,id2`} />
  }

  if (isPending) {
    return <LoadingState message="Loading estimates for comparison..." />
  }

  if (error) {
    return <ErrorState message={error.message} />
  }

  const missingIndex = estimates.indexOf(null)
  if (missingIndex !== -1) {
    return <ErrorState title="Estimate not found" message={estimateIds[missingIndex]} />
  }

  const loaded = estimates as RunEstimate[]
  // Costs share one scale only within a zkVM, while a peak heap is bytes on every zkVM.
  const comparedValues = (['cost', 'heap'] as const).filter((value) => (value === 'cost' ? sameZkvm(loaded) : loaded.every(reportsHeap)))
  if (comparedValues.length === 0) {
    const zkvms = new Set(loaded.map(({ metadata }) => metadata.labels?.zkvm ?? 'no zkVM label'))
    return <ErrorState message={`The costs of ${[...zkvms].join(' and ')} are not on one scale, and not every estimate reports peak heap.`} />
  }

  return (
    <EstimateComparison
      key={estimateIds.join(',')}
      estimateIds={estimateIds}
      estimates={loaded}
      comparedValues={comparedValues}
      search={search}
      onSearchChange={(patch) => navigate({ to: '/estimates/compare', search: { ...search, ...patch }, replace: true })}
    />
  )
}

interface EstimateComparisonProps {
  estimateIds: string[]
  estimates: RunEstimate[]
  /** The figures the estimates compare on. The first one applies unless the URL names another. */
  comparedValues: ComparedValue[]
  search: EstimateCompareSearch
  onSearchChange: (patch: EstimateCompareSearch) => void
}

/** The panels of estimates that compare on their cost or their peak heap. */
function EstimateComparison({ estimateIds, estimates, comparedValues, search, onSearchChange }: EstimateComparisonProps) {
  const headerRef = useRef<HTMLDivElement>(null)
  const { data: suite } = useSuite(estimates[0].suite_hash)
  const baselineIndex = Math.min(Math.max(parseInt(String(search.baseline ?? 0), 10) || 0, 0), estimates.length - 1)
  const labelMode: LabelMode = String(search.labels ?? 'none')
  const testFilter = String(search.filter ?? '')
  const testFilterRegex = String(search.filterRegex) === '1'
  const comparedValue = comparedValues.find((value) => value === search.metric) ?? comparedValues[0]

  // The filter matches the query language, or a regular expression, as on the run compare page.
  const testNameFilter = useMemo((): ((name: string) => boolean) => {
    if (!testFilterRegex) return compileQuery(testFilter)
    const pattern = filterPattern(testFilter)
    return pattern ? (name) => pattern.test(name) : () => true
  }, [testFilter, testFilterRegex])

  // Every ratio of the page reads the tests the filter keeps that every estimate has the figure of.
  const sharedNames = useMemo(() => sharedTests(estimates, testNameFilter, comparedValue), [estimates, testNameFilter, comparedValue])
  // The chart and the table read every test that passed or failed in an estimate.
  const rows = useMemo(() => comparedTests(estimates, suite?.tests, testNameFilter, comparedValue), [estimates, suite?.tests, testNameFilter, comparedValue])

  const runs = useMemo(
    () => estimates.map((estimate, index) => estimateCompareRun(estimateIds[index], estimate, index)),
    [estimateIds, estimates],
  )

  // Filter changes fan out into every panel, so the URL update runs as a transition that keystrokes interrupt.
  const [, startFilterTransition] = useTransition()
  const setBaselineIndex = (index: number) => onSearchChange({ baseline: index > 0 ? index : undefined })
  const setLabelMode = (mode: LabelMode) => onSearchChange({ labels: mode === 'none' ? undefined : mode })
  const setComparedValue = (value: ComparedValue) => onSearchChange({ metric: value === comparedValues[0] ? undefined : value })
  const setTestFilter = (query: string) => startFilterTransition(() => onSearchChange({ filter: query || undefined }))
  const setTestFilterRegex = (enabled: boolean) => startFilterTransition(() => onSearchChange({ filterRegex: enabled ? 1 : undefined }))
  const toggleFilterTerm = (term: string) => setTestFilter(toggleSearchTerm(testFilter, term))

  const mismatches = [
    new Set(estimates.map((estimate) => estimate.suite_hash)).size > 1 && 'suites',
    new Set(estimates.map((estimate) => imageTag(estimate.image))).size > 1 && 'ere tags',
  ].filter(Boolean)

  return (
    <div className="flex flex-col gap-6">
      <StickyRunBar
        runs={runs}
        sentinelRef={headerRef}
        labelMode={labelMode}
        onLabelModeChange={setLabelMode}
        testFilter={testFilter}
        testFilterRegex={testFilterRegex}
        onTestFilterChange={setTestFilter}
        onTestFilterRegexChange={setTestFilterRegex}
        availableGasBuckets={[]}
        selectedGasBuckets={new Set()}
        onToggleGasBucket={() => {}}
        onClearGasBuckets={() => {}}
      />

      <div className="flex min-w-0 items-center gap-2 text-sm/6 text-gray-500 dark:text-gray-400">
        <Link to="/estimates" className="shrink-0 hover:text-gray-700 dark:hover:text-gray-300">
          Estimates
        </Link>
        <span>/</span>
        <span className="shrink-0 text-gray-900 dark:text-gray-100">Compare</span>
      </div>

      <div className="flex flex-wrap items-center gap-4 text-xs/5 text-gray-500 dark:text-gray-400">
        <div className="flex items-center gap-1.5">
          <span>Labels:</span>
          <div className="flex flex-wrap gap-1">
            {buildLabelModeOptions(runs).map((option) => (
              <button
                key={option.value}
                onClick={() => setLabelMode(option.value)}
                className={`rounded-xs px-2 py-0.5 text-xs/5 font-medium transition-colors ${
                  labelMode === option.value
                    ? 'bg-gray-800 text-white dark:bg-gray-200 dark:text-gray-900'
                    : 'bg-gray-100 text-gray-500 hover:bg-gray-200 dark:bg-gray-700 dark:text-gray-400 dark:hover:bg-gray-600'
                }`}
              >
                {option.label}
              </button>
            ))}
          </div>
        </div>
        <div className="flex items-center gap-1.5">
          <span>Filter:</span>
          <FilterInput
            placeholder={testFilterRegex ? 'Regex pattern...' : 'Filter or e.g. opcode:ORIGIN'}
            title={testFilterRegex ? 'Regex against the raw test name.' : TEST_FILTER_HINT}
            value={testFilter}
            onValueChange={setTestFilter}
            className={clsx(
              'rounded-xs border bg-white px-3 py-1 text-sm/6 placeholder-gray-400 focus:outline-hidden focus:ring-1 dark:bg-gray-700 dark:text-gray-100 dark:placeholder-gray-500',
              testFilterRegex && filterPattern(testFilter) === null
                ? 'border-red-400 focus:border-red-500 focus:ring-red-500 dark:border-red-500'
                : 'border-gray-300 focus:border-blue-500 focus:ring-blue-500 dark:border-gray-600',
            )}
          />
          <button
            onClick={() => setTestFilterRegex(!testFilterRegex)}
            title={testFilterRegex ? 'Regex mode (click to switch to text)' : 'Text mode (click to switch to regex)'}
            className={clsx(
              'rounded-xs px-1.5 py-1 font-mono text-sm/6 transition-colors',
              testFilterRegex
                ? 'bg-blue-500 text-white'
                : 'border border-gray-300 bg-white text-gray-500 hover:bg-gray-50 dark:border-gray-600 dark:bg-gray-700 dark:text-gray-400 dark:hover:bg-gray-600',
            )}
          >
            .*
          </button>
        </div>
        {comparedValues.length > 1 && (
          <div className="flex items-center gap-1.5">
            <span>Metric:</span>
            <SegmentedControl
              value={comparedValue}
              onChange={setComparedValue}
              options={comparedValues.map((value) => ({ value, label: COMPARED_VALUES[value].label }))}
              ariaLabel="Metric"
            />
          </div>
        )}
      </div>

      {!comparedValues.includes('cost') && <p className="text-sm/6 text-yellow-600 dark:text-yellow-400">Costs compare only within one zkVM.</p>}

      {mismatches.length > 0 && (
        <div className="rounded-sm border border-yellow-300 bg-yellow-50 p-3 text-sm/6 text-yellow-800 dark:border-yellow-700 dark:bg-yellow-900/20 dark:text-yellow-300">
          Warning: These estimates use different {mismatches.join(' and ')}.
        </div>
      )}

      <div ref={headerRef}>
        <EstimateCompareHeader runs={runs} estimates={estimates} labelMode={labelMode} baselineIndex={baselineIndex} onBaselineChange={setBaselineIndex} />
      </div>

      <EstimatedCostSummary runs={runs} estimates={estimates} sharedNames={sharedNames} testNameFilter={testNameFilter} comparedValue={comparedValue} labelMode={labelMode} baselineIndex={baselineIndex} />
      {sharedNames.length === 0 ? (
        <div className="rounded-sm bg-white shadow-xs dark:bg-gray-800">
          <EmptyState
            title="No shared tests"
            message={testFilter ? 'No test that matches the filter has a value in every estimate.' : 'No test has a value in every estimate.'}
          />
        </div>
      ) : (
        comparedValue === 'cost' && (
          <EstimatedCostComposition runs={runs} estimates={estimates} sharedNames={sharedNames} labelMode={labelMode} baselineIndex={baselineIndex} />
        )
      )}
      <EstimatedCostChart runs={runs} rows={rows} comparedValue={comparedValue} labelMode={labelMode} />
      {sharedNames.length > 0 && (
        <EstimatedCostDimensions runs={runs} estimates={estimates} sharedNames={sharedNames} comparedValue={comparedValue} labelMode={labelMode} baselineIndex={baselineIndex} query={testFilter} onToggle={toggleFilterTerm} />
      )}
      <EstimatedCostTable runs={runs} rows={rows} comparedValue={comparedValue} labelMode={labelMode} baselineIndex={baselineIndex} searchQuery={testFilter} onChipClick={toggleFilterTerm} />
    </div>
  )
}

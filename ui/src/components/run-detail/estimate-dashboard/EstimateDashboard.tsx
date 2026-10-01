import { useMemo } from 'react'
import { TabPanel } from '@headlessui/react'
import { BarChart2, BarChart3, ChartScatter, Coins } from 'lucide-react'
import type { BlockLogs, RunEstimate, SuiteTest } from '@/api/types'
import { measuredTimeLabel } from '@/utils/blockLogs'
import { FIT_MODELS, costKinds, reportsHeap, type FitModelKey } from '@/utils/estimate'
import { useDarkMode } from '../remoteMetricsChart'
import type { TestStatusFilter } from '../TestsTable'
import { CategoryFilter, ThroughputRangeFilter } from '../block-logs-dashboard/components/DashboardFilters'
import { DashboardTabs, type DashboardTabOption } from '../block-logs-dashboard/components/DashboardTabs'
import { useEstimateState } from './hooks/useEstimateState'
import { estimateData, sortRows } from './utils/rows'
import { CorrelationTab } from './components/CorrelationTab'
import { CostRangeFilter } from './components/CostRangeFilter'
import { DimensionTable } from './components/DimensionTable'
import { DistributionTab } from './components/DistributionTab'
import { EstimateTable } from './components/EstimateTable'
import { FailureTable } from './components/FailureTable'
import { OverviewTab } from './components/OverviewTab'
import type { EstimateTab } from './types'

const TABS: DashboardTabOption<EstimateTab>[] = [
  {
    value: 'overview',
    label: 'Overview',
    icon: <BarChart3 className="size-4" />,
  },
  {
    value: 'distribution',
    label: 'Distribution',
    icon: <BarChart2 className="size-4" />,
  },
  {
    value: 'correlation',
    label: 'Correlation',
    icon: <ChartScatter className="size-4" />,
  },
]

interface EstimateDashboardProps {
  estimate: RunEstimate
  blockLogs?: BlockLogs | null
  /** True when the run's client proves blocks rather than executing them. */
  isProving: boolean
  /** Suite tests in canonical run order, so Test # matches the other charts. */
  suiteTests?: SuiteTest[]
  /** Only tests whose name matches this query are read. */
  searchQuery?: string
  /** Only tests this accepts are read, which carries the status filter of the page. */
  includeTest?: (testName: string) => boolean
  /** The run status the page keeps. The Tests header shows its buttons only together with onStatusFilterChange. */
  statusFilter?: TestStatusFilter
  onStatusFilterChange?: (status: TestStatusFilter) => void
  onSearchTermToggle?: (term: string) => void
  onTestClick?: (testName: string) => void
}

/** An estimate with the cost of each test, fitted against the time of the block logs where a run of the same name holds them. */
export function EstimateDashboard({ estimate, blockLogs, isProving, suiteTests, searchQuery, includeTest, statusFilter, onStatusFilterChange, onSearchTermToggle, onTestClick }: EstimateDashboardProps) {
  const isDark = useDarkMode()
  const { state, updateState } = useEstimateState()

  const kinds = useMemo(() => costKinds([estimate]), [estimate])
  const { categories, minThroughput, maxThroughput, minCost, maxCost, fitModel } = state
  const data = useMemo(() => {
    const filters = { categories, minThroughput, maxThroughput, minCost, maxCost, fitModel }
    return estimateData({ estimate, blockLogs, isProving, kinds, suiteTests, searchQuery, includeTest, state: filters })
  }, [estimate, blockLogs, isProving, kinds, suiteTests, searchQuery, includeTest, categories, minThroughput, maxThroughput, minCost, maxCost, fitModel])
  const sorted = useMemo(() => sortRows(data.rows, kinds, state), [data.rows, kinds, state])
  const timeLabel = measuredTimeLabel(isProving)

  // The correlation reads the block logs, so an estimate without them has two tabs.
  const tabs = data.hasTiming ? TABS : TABS.filter((tab) => tab.value !== 'correlation')

  const header = (
    <div className="flex items-center justify-between border-b border-gray-200 px-4 py-3 last:border-b-0 dark:border-gray-700">
      <div className="flex flex-wrap items-center gap-3">
        <h3 className="flex items-center gap-2 text-sm font-medium text-gray-900 dark:text-gray-100">
          <Coins className="size-4 text-gray-400 dark:text-gray-500" />
          Estimated Cost Analysis
        </h3>
        <span className="rounded-full bg-purple-100 px-2 py-0.5 text-xs font-medium text-purple-700 dark:bg-purple-900/50 dark:text-purple-300">
          {data.passed} passed
        </span>
        {data.failed > 0 && (
          <span className="rounded-full bg-red-100 px-2 py-0.5 text-xs font-medium text-red-700 dark:bg-red-900/50 dark:text-red-300">
            {data.failed} failed
          </span>
        )}
        {data.missing > 0 && (
          <span className="rounded-full bg-amber-100 px-2 py-0.5 text-xs font-medium text-amber-700 dark:bg-amber-900/50 dark:text-amber-300">
            {data.missing} missing
          </span>
        )}
      </div>
    </div>
  )
  const failureTable = data.failures.length > 0 && <FailureTable testNames={data.failures} failures={estimate.failures ?? {}} suiteTests={suiteTests} searchQuery={searchQuery} onChipClick={onSearchTermToggle} onTestClick={onTestClick} />

  // An estimate with no passed test leaves nothing to chart, only its coverage and its failures.
  if (kinds.length === 0) {
    return (
      <div className="flex flex-col gap-6">
        <div className="overflow-hidden rounded-sm bg-white shadow-xs dark:bg-gray-800">
          {header}
        </div>
        {failureTable}
      </div>
    )
  }

  return (
    <div className="flex flex-col gap-6">
      <div className="overflow-hidden rounded-sm bg-white shadow-xs dark:bg-gray-800">
        {header}

        <div className="flex flex-wrap items-center gap-4 border-b border-gray-200 px-4 py-3 dark:border-gray-700">
          <CategoryFilter categories={state.categories} breakdown={data.breakdown} onChange={(selected) => updateState({ categories: selected })} />
          {data.hasTiming && (
            <div className="flex items-center gap-2">
              <span className="text-xs text-gray-500 dark:text-gray-400">Model:</span>
              <select
                value={state.fitModel}
                onChange={(e) => updateState({ fitModel: e.target.value as FitModelKey })}
                className="rounded-sm border border-gray-300 bg-white px-2 py-1.5 text-sm text-gray-900 dark:border-gray-600 dark:bg-gray-700 dark:text-gray-100"
              >
                {FIT_MODELS.map((model) => (
                  <option key={model.value} value={model.value}>
                    {model.label}
                  </option>
                ))}
              </select>
            </div>
          )}
          {data.hasTiming && (
            <ThroughputRangeFilter min={state.minThroughput} max={state.maxThroughput} limit={data.maxThroughput ?? undefined} onChange={updateState} />
          )}
          <CostRangeFilter min={state.minCost} max={state.maxCost} lowest={data.minCost} highest={data.maxCost} onChange={updateState} />

          <div className="ml-auto text-xs text-gray-500 dark:text-gray-400">
            {data.rows.length} tests
          </div>
        </div>

        <DashboardTabs tabs={tabs} activeTab={state.activeTab} onTabChange={(activeTab) => updateState({ activeTab })}>
          <TabPanel>
            <OverviewTab rows={data.rows} kinds={kinds} isDark={isDark} onTestClick={onTestClick} />
          </TabPanel>
          <TabPanel>
            <DistributionTab rows={data.rows} />
          </TabPanel>
          {data.hasTiming && (
            <TabPanel>
              <CorrelationTab rows={data.rows} fit={data.fit} timeLabel={timeLabel} isDark={isDark} onTestClick={onTestClick} />
            </TabPanel>
          )}
        </DashboardTabs>
      </div>

      <DimensionTable
        rows={data.rows}
        failures={data.failures}
        kinds={kinds}
        reportsHeap={reportsHeap(estimate)}
        costShare={state.costShare}
        onCostShareChange={(costShare) => updateState({ costShare })}
        signedError={state.signedError}
        onSignedErrorChange={(signedError) => updateState({ signedError })}
        hasTiming={data.hasTiming}
        searchQuery={searchQuery}
        onSearchTermToggle={onSearchTermToggle}
      />

      <EstimateTable
        data={sorted}
        kinds={kinds}
        suiteTests={suiteTests}
        state={state}
        onUpdate={updateState}
        onTestClick={onTestClick}
        searchQuery={searchQuery}
        onChipClick={onSearchTermToggle}
        timeLabel={timeLabel}
        hasTiming={data.hasTiming}
        reportsHeap={reportsHeap(estimate)}
        statusFilter={statusFilter}
        onStatusFilterChange={onStatusFilterChange}
      />

      {failureTable}
    </div>
  )
}

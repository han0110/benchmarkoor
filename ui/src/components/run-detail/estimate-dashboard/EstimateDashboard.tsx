import { useMemo } from 'react'
import { TabPanel } from '@headlessui/react'
import { BarChart2, BarChart3, ChartScatter, Coins } from 'lucide-react'
import type { BlockLogs, RunEstimate, SuiteTest, TestEntry } from '@/api/types'
import { measuredTimeLabel } from '@/utils/blockLogs'
import { FIT_MODELS, costKinds, type FitModelKey } from '@/utils/estimate'
import { useDarkMode, useStatusFilter } from '../remoteMetricsChart'
import type { TestStatusFilter } from '../TestsTable'
import { CategoryFilter, ThroughputRangeFilter } from '../block-logs-dashboard/components/DashboardFilters'
import { DashboardTabs, type DashboardTabOption } from '../block-logs-dashboard/components/DashboardTabs'
import { useEstimateState } from './hooks/useEstimateState'
import { estimateData } from './utils/rows'
import { CorrelationTab } from './components/CorrelationTab'
import { DistributionTab } from './components/DistributionTab'
import { EstimateTable } from './components/EstimateTable'
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
  runId: string
  /** True when the run's client proves blocks rather than executing them. */
  isProving: boolean
  /** Suite tests in canonical run order, so Test # matches the other charts. */
  suiteTests?: SuiteTest[]
  /** Only tests whose name matches this query are read. */
  searchQuery?: string
  /** Test results, which carry the pass or fail state the status filter reads. */
  tests?: Record<string, TestEntry>
  statusFilter?: TestStatusFilter
  onTestClick?: (testName: string) => void
}

/** The estimate of the run, priced per test and fitted against the time the block logs measured. */
export function EstimateDashboard({ estimate, blockLogs, runId, isProving, suiteTests, searchQuery, tests, statusFilter, onTestClick }: EstimateDashboardProps) {
  const isDark = useDarkMode()
  const includeTest = useStatusFilter(tests, statusFilter)
  const { state, updateState } = useEstimateState(runId)

  const kinds = useMemo(() => costKinds([estimate]), [estimate])
  const data = useMemo(
    () => estimateData({ estimate, blockLogs, isProving, kinds, suiteTests, searchQuery, includeTest, state }),
    [estimate, blockLogs, isProving, kinds, suiteTests, searchQuery, includeTest, state],
  )
  const timeLabel = measuredTimeLabel(isProving)

  // A run with no priced kind leaves nothing to chart.
  if (kinds.length === 0) return null

  // The correlation reads the block logs, so a run without them has two tabs.
  const tabs = data.hasTiming ? TABS : TABS.filter((tab) => tab.value !== 'correlation')

  return (
    <div className="overflow-hidden rounded-sm bg-white shadow-xs dark:bg-gray-800">
      <div className="flex items-center justify-between border-b border-gray-200 px-4 py-3 dark:border-gray-700">
        <div className="flex items-center gap-3">
          <h3 className="flex items-center gap-2 text-sm font-medium text-gray-900 dark:text-gray-100">
            <Coins className="size-4 text-gray-400 dark:text-gray-500" />
            Estimated Cost Analysis
          </h3>
          <span className="rounded-full bg-purple-100 px-2 py-0.5 text-xs font-medium text-purple-700 dark:bg-purple-900/50 dark:text-purple-300">
            {data.priced} tests
          </span>
        </div>
      </div>

      <div className="flex flex-wrap items-center gap-4 border-b border-gray-200 px-4 py-3 dark:border-gray-700">
        <CategoryFilter categories={state.categories} breakdown={data.breakdown} onChange={(categories) => updateState({ categories })} />
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

        <div className="flex items-center gap-4">
          <label className="flex cursor-pointer items-center gap-1.5 text-xs text-gray-600 dark:text-gray-400">
            <input
              type="checkbox"
              checked={state.costShare}
              onChange={(e) => updateState({ costShare: e.target.checked })}
              className="rounded-xs border-gray-300 text-blue-600 focus:ring-blue-500 dark:border-gray-600"
            />
            Cost share
          </label>
          {data.hasTiming && (
            <label className="flex cursor-pointer items-center gap-1.5 text-xs text-gray-600 dark:text-gray-400">
              <input
                type="checkbox"
                checked={state.signedError}
                onChange={(e) => updateState({ signedError: e.target.checked })}
                className="rounded-xs border-gray-300 text-blue-600 focus:ring-blue-500 dark:border-gray-600"
              />
              Signed error
            </label>
          )}
        </div>

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

      <EstimateTable data={data.sorted} kinds={kinds} state={state} onUpdate={updateState} onTestClick={onTestClick} timeLabel={timeLabel} hasTiming={data.hasTiming} />
    </div>
  )
}

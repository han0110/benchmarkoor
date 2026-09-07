import { useMemo, useState } from 'react'
import clsx from 'clsx'
import ReactECharts from 'echarts-for-react'
import { Coins } from 'lucide-react'
import type { BlockLogs, RunEstimate, SuiteTest } from '@/api/types'
import { EmptyState } from '@/components/shared/EmptyState'
import { SegmentedControl } from '@/components/shared/SegmentedControl'
import { compositionOption } from '@/components/shared/costCompositionChart'
import { useDarkMode } from '@/components/run-detail/remoteMetricsChart'
import { getClientLogoUrl } from '@/utils/client-colors'
import { costKinds, sameZkvm, sharedTestNames } from '@/utils/estimate'
import { MIN_COMPARE_RUNS, RUN_SLOTS, formatRunLabel, type CompareRun, type LabelMode } from './constants'

interface EstimatedCostCompositionProps {
  runs: CompareRun[]
  estimatesPerRun: (RunEstimate | null)[]
  blockLogsPerRun: (BlockLogs | null)[]
  suiteTests?: SuiteTest[]
  labelMode: LabelMode
  testNameFilter?: (name: string) => boolean
}

/** States what every run's zkVM priced the same tests at, kind by kind. */
export function EstimatedCostComposition({
  runs,
  estimatesPerRun,
  blockLogsPerRun,
  suiteTests,
  labelMode,
  testNameFilter,
}: EstimatedCostCompositionProps) {
  const isDark = useDarkMode()
  const [shares, setShares] = useState(false)

  const compared = useMemo(
    () =>
      runs.flatMap((run, index) => {
        const estimate = estimatesPerRun[index]
        return estimate ? [{ run, estimate, blockLogs: blockLogsPerRun[index] }] : []
      }),
    [runs, estimatesPerRun, blockLogsPerRun],
  )

  // Tests every run both estimated and timed, in the order the suite ran them.
  const shared = useMemo(() => {
    if (compared.length < MIN_COMPARE_RUNS) return []
    const order = new Map(suiteTests?.map((test, index) => [test.name, index]))
    return sharedTestNames(compared.map((entry) => entry.estimate))
      .filter(
        (name) =>
          (!testNameFilter || testNameFilter(name)) &&
          compared.every(({ blockLogs }) => blockLogs?.[name] != null),
      )
      .sort((left, right) => {
        const orderLeft = order.get(left)
        const orderRight = order.get(right)
        if (orderLeft !== undefined && orderRight !== undefined) return orderLeft - orderRight
        if (orderLeft !== undefined) return -1
        if (orderRight !== undefined) return 1
        return left.localeCompare(right)
      })
  }, [compared, suiteTests, testNameFilter])

  const kinds = useMemo(() => costKinds(compared.map((entry) => entry.estimate)), [compared])

  const composition = useMemo(() => {
    if (shared.length === 0 || kinds.length === 0) return null
    return compositionOption({
      bars: compared.map(({ run, estimate }) => ({
        label: `Run ${formatRunLabel(RUN_SLOTS[run.index], run, labelMode)}`,
        // Divided by the tests, so a bar totals the mean cost of one test.
        components: kinds.map(
          (kind) => shared.reduce((sum, name) => sum + (estimate.tests[name].cost[kind] ?? 0), 0) / shared.length,
        ),
      })),
      kinds,
      isDark,
      shares,
    })
  }, [compared, shared, kinds, labelMode, isDark, shares])

  if (compared.length < MIN_COMPARE_RUNS || shared.length === 0) return null

  const mixedZkvms = !sameZkvm(compared.map(({ estimate }) => estimate))

  const header = (
    <div className="flex items-center gap-2">
      <Coins className="size-4 text-gray-400 dark:text-gray-500" />
      <h3 className="text-sm/6 font-medium text-gray-900 dark:text-gray-100">Estimated Cost Composition</h3>
      <div className="ml-auto flex items-center gap-2 text-xs/5">
        {compared.map(({ run, estimate }) => {
          const slot = RUN_SLOTS[run.index]
          return (
            <span
              key={slot.label}
              className={clsx('inline-flex items-center gap-1.5 rounded-sm px-2 py-0.5 font-medium', slot.badgeBgClass, slot.badgeTextClass)}
              title={estimate.image}
            >
              <img src={getClientLogoUrl(run.config.instance.client)} alt={run.config.instance.client} className="size-3.5 rounded-full object-cover" />
              {formatRunLabel(slot, run, labelMode)}
              <span className="font-normal opacity-70">{estimate.zkvm}</span>
            </span>
          )
        })}
        {!mixedZkvms && (
          <SegmentedControl
            value={shares ? 'share' : 'absolute'}
            onChange={(next) => setShares(next === 'share')}
            options={[
              { value: 'absolute', label: 'Absolute' },
              { value: 'share', label: 'Share' },
            ]}
            ariaLabel="Composition values"
          />
        )}
      </div>
    </div>
  )

  if (mixedZkvms) {
    return (
      <div className="flex flex-col gap-4 rounded-sm bg-white p-4 shadow-xs dark:bg-gray-800">
        {header}
        <EmptyState
          title="Estimated costs are not comparable"
          message="The runs use different zkVMs, whose cost units are not on one scale."
        />
      </div>
    )
  }

  return (
    <div className="flex flex-col gap-4 rounded-sm bg-white p-4 shadow-xs dark:bg-gray-800">
      {header}

      {composition && (
        <div className="rounded-xs bg-gray-50 p-3 dark:bg-gray-700/50">
          <ReactECharts
            option={composition}
            style={{ height: `${60 + compared.length * 44}px`, width: '100%' }}
            opts={{ renderer: 'svg' }}
            notMerge
          />
        </div>
      )}
    </div>
  )
}

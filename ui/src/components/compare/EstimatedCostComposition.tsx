import { useMemo, useState, type ReactNode } from 'react'
import clsx from 'clsx'
import ReactECharts from 'echarts-for-react'
import { Coins } from 'lucide-react'
import type { RunEstimate } from '@/api/types'
import { EstimateBadge } from '@/components/estimates/EstimateCompareHeader'
import { SegmentedControl } from '@/components/shared/SegmentedControl'
import { compositionOption, kindColor } from '@/components/shared/costCompositionChart'
import { useDarkMode } from '@/components/run-detail/remoteMetricsChart'
import { costKinds, costTitle, formatCost, formatRatio, ratioClass } from '@/utils/estimate'
import { RUN_SLOTS, formatRunLabel, type CompareRun, type LabelMode } from './constants'
import { kindRatios, type KindRatio } from './estimateComparison'

interface EstimatedCostCompositionProps {
  runs: CompareRun[]
  estimates: RunEstimate[]
  /** The tests the filter keeps that are estimated in every estimate. */
  sharedNames: string[]
  labelMode: LabelMode
  /** Index of the estimate every total states its ratio to. */
  baselineIndex: number
}

/** One row of the kind table, which states the mean of every estimate and then the ratio of every estimate but the baseline. */
function KindRow({ row, baselineIndex, total = false, children }: { row: KindRatio; baselineIndex: number; total?: boolean; children: ReactNode }) {
  return (
    <tr className={clsx('font-mono text-sm/6 text-gray-900 dark:text-gray-100', total && 'border-t-2 border-gray-300 font-semibold dark:border-gray-600')}>
      <td className="sticky left-0 whitespace-nowrap bg-white px-3 py-1.5 font-sans dark:bg-gray-800">{children}</td>
      {row.means.map((mean, at) => (
        <td key={`mean-${at}`} title={costTitle(mean)} className="px-3 py-1.5 text-right">
          {formatCost(mean)}
        </td>
      ))}
      {row.ratios.map((ratio, at) =>
        at === baselineIndex ? null : (
          <td key={`ratio-${at}`} className={clsx('px-3 py-1.5 text-right', ratio !== null && ratioClass(ratio))}>
            {ratio === null ? '-' : formatRatio(ratio)}
          </td>
        ),
      )}
    </tr>
  )
}

/** States the estimated cost of the same tests in every estimate, kind by kind. */
export function EstimatedCostComposition({
  runs,
  estimates,
  sharedNames,
  labelMode,
  baselineIndex,
}: EstimatedCostCompositionProps) {
  const isDark = useDarkMode()
  const [shares, setShares] = useState(false)

  const kinds = useMemo(() => costKinds(estimates), [estimates])

  // The bars and the kind table read the same means, so the Total row equals the sum ratio.
  const kindTable = useMemo(() => kindRatios(estimates, sharedNames, kinds, baselineIndex), [estimates, sharedNames, kinds, baselineIndex])

  const composition = useMemo(() => {
    if (kinds.length === 0) return null
    return compositionOption({
      bars: runs.map((run, at) => ({
        label: formatRunLabel(RUN_SLOTS[run.index], run, labelMode),
        // Divided by the tests, so a bar totals the mean cost of one test.
        components: kindTable.kinds.map((kind) => kind.means[at]),
      })),
      kinds,
      isDark,
      shares,
      baselineIndex,
    })
  }, [runs, kindTable, kinds, labelMode, isDark, shares, baselineIndex])

  const header = (
    <div className="flex flex-wrap items-center gap-2">
      <Coins className="size-4 text-gray-400 dark:text-gray-500" />
      <h3 className="text-sm/6 font-medium text-gray-900 dark:text-gray-100">Estimated Cost Composition</h3>
      <div className="ml-auto flex flex-wrap items-center gap-2 text-xs/5">
        {runs.map((run) => (
          <EstimateBadge key={run.runId} run={run} labelMode={labelMode} />
        ))}
        <SegmentedControl
          value={shares ? 'share' : 'absolute'}
          onChange={(next) => setShares(next === 'share')}
          options={[
            { value: 'absolute', label: 'Absolute' },
            { value: 'share', label: 'Share' },
          ]}
          ariaLabel="Composition values"
        />
      </div>
    </div>
  )

  const kindHeader = (run: CompareRun, label: string) => (
    <th key={`${label}-${run.runId}`} scope="col" className="px-3 py-2 text-right text-xs/5 font-medium uppercase tracking-wider text-gray-500 dark:text-gray-400">
      <span className="flex flex-col items-end gap-1">
        <EstimateBadge run={run} labelMode={labelMode} />
        {label}
      </span>
    </th>
  )

  return (
    <div className="flex flex-col gap-4 rounded-sm bg-white p-4 shadow-xs dark:bg-gray-800">
      {header}

      {composition && (
        <div className="rounded-xs bg-gray-50 p-3 dark:bg-gray-700/50">
          <ReactECharts
            option={composition}
            style={{ height: `${60 + runs.length * 44}px`, width: '100%' }}
            opts={{ renderer: 'svg' }}
            notMerge
          />
        </div>
      )}

      <div className="max-h-[70vh] overflow-auto">
        <table className="min-w-full divide-y divide-gray-200 dark:divide-gray-700">
          <thead className="sticky top-0 z-10 bg-gray-50 dark:bg-gray-900">
            <tr>
              <th scope="col" className="sticky left-0 z-20 bg-gray-50 px-3 py-2 text-left text-xs/5 font-medium uppercase tracking-wider text-gray-500 dark:bg-gray-900 dark:text-gray-400">
                Kind
              </th>
              {runs.map((run) => kindHeader(run, 'Mean'))}
              {runs.map((run, at) => at !== baselineIndex && kindHeader(run, 'Ratio'))}
            </tr>
          </thead>
          <tbody>
            {kinds.map((kind, at) => (
              <KindRow key={kind} row={kindTable.kinds[at]} baselineIndex={baselineIndex}>
                <span className="flex items-center gap-2">
                  <span className="size-2 rounded-full" style={{ backgroundColor: kindColor(at) }} />
                  {kind}
                </span>
              </KindRow>
            ))}
            <KindRow row={kindTable.total} baselineIndex={baselineIndex} total>
              Total
            </KindRow>
          </tbody>
        </table>
      </div>
    </div>
  )
}

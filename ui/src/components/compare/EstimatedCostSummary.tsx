import { useMemo } from 'react'
import { Scale } from 'lucide-react'
import type { RunEstimate } from '@/api/types'
import { EstimateBadge } from '@/components/estimates/EstimateCompareHeader'
import { NEUTRAL_BAND, formatPercent, formatRatio, ratioClass } from '@/utils/estimate'
import type { CompareRun, LabelMode } from './constants'
import { COMPARED_VALUES, estimateCoverage, ratioSummary, type ComparedValue } from './estimateComparison'

interface EstimatedCostSummaryProps {
  runs: CompareRun[]
  estimates: RunEstimate[]
  /** The tests the filter keeps that every estimate has the figure of. */
  sharedNames: string[]
  testNameFilter: (name: string) => boolean
  comparedValue: ComparedValue
  labelMode: LabelMode
  baselineIndex: number
}

/** The columns of the summary. The names of the counts below and above the neutral band follow the figure. */
function summaryColumns(comparedValue: ComparedValue): { label: string; title?: string }[] {
  const [below, above] = comparedValue === 'cost' ? ['Cheaper', 'Dearer'] : ['Lower', 'Higher']
  return [
    { label: 'Passed', title: 'Tests the filter keeps that passed in this estimate' },
    { label: 'Failed', title: 'Tests the filter keeps that failed in this estimate' },
    { label: 'Outside', title: 'Passed tests that another estimate failed or has no value for, with their share of the cost of this estimate. No ratio reads them.' },
    { label: 'Geomean', title: 'Geometric mean of the per-test ratio to the baseline over the shared tests' },
    { label: 'Sum', title: 'Sum over the shared tests divided by the sum of the baseline' },
    { label: 'P5', title: '5th percentile of the per-test ratio to the baseline' },
    { label: 'P50', title: 'Median of the per-test ratio to the baseline' },
    { label: 'P95', title: '95th percentile of the per-test ratio to the baseline' },
    { label: below, title: `Shared tests below ${formatRatio(1 - NEUTRAL_BAND)} of the baseline` },
    { label: 'Within 2%', title: `Shared tests from ${formatRatio(1 - NEUTRAL_BAND)} to ${formatRatio(1 + NEUTRAL_BAND)} of the baseline` },
    { label: above, title: `Shared tests above ${formatRatio(1 + NEUTRAL_BAND)} of the baseline` },
  ]
}

const Ratio = ({ ratio }: { ratio: number }) => <span className={ratioClass(ratio)}>{formatRatio(ratio)}</span>

/** States per estimate the tests the filter keeps and how the shared tests compare with the baseline. */
export function EstimatedCostSummary({ runs, estimates, sharedNames, testNameFilter, comparedValue, labelMode, baselineIndex }: EstimatedCostSummaryProps) {
  const rows = useMemo(() => {
    const shared = new Set(sharedNames)
    return estimates.map((estimate, at) => ({
      coverage: estimateCoverage(estimate, shared, testNameFilter),
      summary: at === baselineIndex ? null : ratioSummary(estimate, estimates[baselineIndex], sharedNames, comparedValue),
    }))
  }, [estimates, sharedNames, testNameFilter, comparedValue, baselineIndex])
  const columns = summaryColumns(comparedValue)

  return (
    <div className="overflow-hidden rounded-sm bg-white shadow-xs dark:bg-gray-800">
      <div className="flex items-center gap-2 border-b border-gray-200 px-4 py-3 dark:border-gray-700">
        <Scale className="size-4 text-gray-400 dark:text-gray-500" />
        <h3 className="text-sm/6 font-medium text-gray-900 dark:text-gray-100">{COMPARED_VALUES[comparedValue].label} Summary</h3>
      </div>
      <div className="max-h-[70vh] overflow-auto">
        <table className="min-w-full divide-y divide-gray-200 dark:divide-gray-700">
          <thead className="sticky top-0 z-10 bg-gray-50 dark:bg-gray-900">
            <tr>
              <th scope="col" className="sticky left-0 z-20 bg-gray-50 px-3 py-2 text-left text-xs/5 font-medium uppercase tracking-wider text-gray-500 dark:bg-gray-900 dark:text-gray-400">
                Estimate
              </th>
              {columns.map(({ label, title }) => (
                <th key={label} scope="col" title={title} className="whitespace-nowrap px-3 py-2 text-right text-xs/5 font-medium uppercase tracking-wider text-gray-500 dark:text-gray-400">
                  {label}
                </th>
              ))}
            </tr>
          </thead>
          <tbody className="divide-y divide-gray-200 dark:divide-gray-700">
            {rows.map(({ coverage, summary }, at) => (
              <tr key={runs[at].runId} className="font-mono text-sm/6 text-gray-900 dark:text-gray-100">
                <td className="sticky left-0 whitespace-nowrap bg-white px-3 py-2 font-sans dark:bg-gray-800">
                  <span className="flex items-center gap-2">
                    <EstimateBadge run={runs[at]} labelMode={labelMode} />
                    {at === baselineIndex && <span className="text-xs/5 text-gray-500 dark:text-gray-400">baseline</span>}
                  </span>
                </td>
                <td className="px-3 py-2 text-right">{coverage.passed}</td>
                <td className={coverage.failed > 0 ? 'px-3 py-2 text-right text-red-600 dark:text-red-400' : 'px-3 py-2 text-right'}>{coverage.failed}</td>
                <td className="whitespace-nowrap px-3 py-2 text-right">
                  {coverage.outside}
                  {coverage.outside > 0 && coverage.outsideShare !== null && (
                    <span className="text-gray-500 dark:text-gray-400"> ({formatPercent(coverage.outsideShare)})</span>
                  )}
                </td>
                {summary ? (
                  <>
                    <td className="px-3 py-2 text-right"><Ratio ratio={summary.geomean} /></td>
                    <td className="px-3 py-2 text-right"><Ratio ratio={summary.sumRatio} /></td>
                    <td className="px-3 py-2 text-right"><Ratio ratio={summary.p5} /></td>
                    <td className="px-3 py-2 text-right"><Ratio ratio={summary.p50} /></td>
                    <td className="px-3 py-2 text-right"><Ratio ratio={summary.p95} /></td>
                    <td className="px-3 py-2 text-right">{summary.cheaper}</td>
                    <td className="px-3 py-2 text-right">{summary.within}</td>
                    <td className="px-3 py-2 text-right">{summary.dearer}</td>
                  </>
                ) : (
                  columns.slice(3).map(({ label }) => (
                    <td key={label} className="px-3 py-2 text-right text-gray-400 dark:text-gray-500">-</td>
                  ))
                )}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  )
}

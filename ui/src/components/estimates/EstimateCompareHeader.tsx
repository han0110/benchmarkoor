import { Link } from '@tanstack/react-router'
import clsx from 'clsx'
import type { RunEstimate } from '@/api/types'
import { useRunIds } from '@/api/hooks/useEstimate'
import { RUN_SLOTS, formatRunLabel, type CompareRun, type LabelMode } from '@/components/compare/constants'
import { ClientBadge } from '@/components/shared/ClientBadge'
import { getClientLogoUrl } from '@/utils/client-colors'
import { formatRelativeTime, formatTimestamp } from '@/utils/date'
import { imageTag } from './estimateEntries'

/** The slot of an estimate in its colour, which names the estimate in every panel of the comparison. */
export function EstimateBadge({ run, labelMode }: { run: CompareRun; labelMode: LabelMode }) {
  const slot = RUN_SLOTS[run.index]

  return (
    <span className={clsx('inline-flex items-center gap-1.5 whitespace-nowrap rounded-sm px-2 py-0.5 text-xs/5 font-medium normal-case tracking-normal', slot.badgeBgClass, slot.badgeTextClass)}>
      <img src={getClientLogoUrl(run.config.instance.client)} alt={run.config.instance.client} className="size-3.5 rounded-full object-cover" />
      {formatRunLabel(slot, run, labelMode)}
    </span>
  )
}

interface EstimateCompareHeaderProps {
  runs: CompareRun[]
  estimates: RunEstimate[]
  labelMode: LabelMode
  baselineIndex: number
  onBaselineChange: (index: number) => void
}

/** One card per estimate, which names the subject of the estimate and selects the baseline. */
export function EstimateCompareHeader({ runs, estimates, labelMode, baselineIndex, onBaselineChange }: EstimateCompareHeaderProps) {
  const runIds = useRunIds()

  return (
    <div className="grid grid-cols-[repeat(auto-fit,minmax(14rem,1fr))] gap-4">
      {runs.map((run, at) => {
        const slot = RUN_SLOTS[run.index]
        const { image, timestamp } = estimates[at]
        const zkvmVersion = run.config.metadata?.labels?.zkvm_version
        const isBaseline = at === baselineIndex

        return (
          <div key={run.runId} className={clsx('flex min-w-0 flex-col gap-3 rounded-sm border-t-3 bg-white p-4 shadow-xs dark:bg-gray-800', slot.borderClass)}>
            <div className="flex items-center justify-between gap-2">
              <span className="text-xs/5 font-semibold uppercase tracking-wider text-gray-500 dark:text-gray-400">
                {formatRunLabel(slot, run, labelMode)}
              </span>
              <button
                type="button"
                onClick={() => onBaselineChange(at)}
                disabled={isBaseline}
                className={clsx(
                  'rounded-xs px-2 py-0.5 text-xs/5 font-medium transition-colors',
                  isBaseline
                    ? `${slot.badgeBgClass} ${slot.badgeTextClass} ring-1 ring-current`
                    : 'bg-gray-100 text-gray-500 hover:bg-gray-200 dark:bg-gray-700 dark:text-gray-400 dark:hover:bg-gray-600',
                )}
              >
                {isBaseline ? 'Baseline' : 'Set as baseline'}
              </button>
            </div>
            <ClientBadge client={run.config.instance.client} metadata={run.config.metadata?.labels} />
            <div className="flex flex-col gap-1">
              <div className="flex min-w-0 items-center gap-2">
                <span className="shrink-0 text-xs/5 text-gray-500 dark:text-gray-400">Estimate:</span>
                <Link
                  to="/estimates/$estimateId"
                  params={{ estimateId: run.runId }}
                  className="truncate font-mono text-sm/6 text-blue-600 hover:text-blue-800 hover:underline dark:text-blue-400 dark:hover:text-blue-300"
                  title={run.runId}
                >
                  {run.runId}
                </Link>
              </div>
              {runIds?.has(run.runId) && (
                <div className="flex min-w-0 items-center gap-2">
                  <span className="shrink-0 text-xs/5 text-gray-500 dark:text-gray-400">Run:</span>
                  <Link
                    to="/runs/$runId"
                    params={{ runId: run.runId }}
                    className="truncate font-mono text-sm/6 text-blue-600 hover:text-blue-800 hover:underline dark:text-blue-400 dark:hover:text-blue-300"
                    title={run.runId}
                  >
                    {run.runId}
                  </Link>
                </div>
              )}
              {zkvmVersion && (
                <div className="flex min-w-0 items-center gap-2">
                  <span className="shrink-0 text-xs/5 text-gray-500 dark:text-gray-400">Version:</span>
                  <span className="truncate font-mono text-sm/6 text-gray-900 dark:text-gray-100">{zkvmVersion}</span>
                </div>
              )}
              <div className="flex min-w-0 items-center gap-2">
                <span className="shrink-0 text-xs/5 text-gray-500 dark:text-gray-400">Image:</span>
                <span className="truncate font-mono text-sm/6 text-gray-900 dark:text-gray-100" title={image}>
                  {imageTag(image)}
                </span>
              </div>
              <div className="flex items-center gap-2">
                <span className="text-xs/5 text-gray-500 dark:text-gray-400">Time:</span>
                <span className="text-sm/6 text-gray-900 dark:text-gray-100" title={formatRelativeTime(timestamp)}>
                  {formatTimestamp(timestamp)}
                </span>
              </div>
            </div>
          </div>
        )
      })}
    </div>
  )
}

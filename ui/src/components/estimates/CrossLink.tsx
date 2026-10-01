import { Link } from '@tanstack/react-router'
import { ArrowRight } from 'lucide-react'
import { useEstimateIds, useRunIds } from '@/api/hooks/useEstimate'

interface CrossLinkProps {
  /** The id that the run and the estimate share. */
  id: string
  /** The page that the link opens. */
  target: 'run' | 'estimate'
}

/** The link from a run to the estimate of the same name, or back. It shows only where the index of the target holds the id. */
export function CrossLink({ id, target }: CrossLinkProps) {
  const runIds = useRunIds()
  const { data: estimateIds } = useEstimateIds()

  if (!(target === 'run' ? runIds : estimateIds)?.has(id)) return null

  // The ring, shadow, and hover of the run page buttons.
  const className =
    'ml-1 flex shrink-0 items-center gap-1 rounded-xs bg-white px-2 py-0.5 text-xs/5 font-medium text-gray-700 shadow-xs ring-1 ring-inset ring-gray-300 transition-colors hover:bg-gray-50 hover:text-gray-900 dark:bg-gray-800 dark:text-gray-200 dark:ring-gray-600 dark:hover:bg-gray-700 dark:hover:text-gray-100'
  const arrow = <ArrowRight className="size-3.5" />

  return target === 'run' ? (
    <Link to="/runs/$runId" params={{ runId: id }} className={className} title="Open the run of this estimate">
      Run
      {arrow}
    </Link>
  ) : (
    <Link to="/estimates/$estimateId" params={{ estimateId: id }} className={className} title="Open the estimate of this run">
      Estimate
      {arrow}
    </Link>
  )
}

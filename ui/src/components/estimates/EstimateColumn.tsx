import { Link } from '@tanstack/react-router'
import { useEstimateIds } from '@/api/hooks/useEstimate'

export function EstimateColumnHeader() {
  return (
    <th className="px-1.5 py-2 text-center text-xs/5 font-medium uppercase tracking-wider text-gray-500 sm:px-2 dark:text-gray-400">
      Estimate
    </th>
  )
}

/** The link to the estimate with the id of the run, empty where the run has none. */
export function EstimateColumnCell({ runId }: { runId: string }) {
  const { data: estimateIds } = useEstimateIds()

  return (
    <td className="whitespace-nowrap px-1.5 py-2 text-center text-sm/6 sm:px-2 sm:py-2.5">
      {estimateIds?.has(runId) && (
        <Link
          to="/estimates/$estimateId"
          params={{ estimateId: runId }}
          onClick={(e) => e.stopPropagation()}
          className="text-blue-600 hover:text-blue-800 hover:underline dark:text-blue-400 dark:hover:text-blue-300"
        >
          View
        </Link>
      )}
    </td>
  )
}

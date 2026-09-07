import { useQueries, useQuery, type UseQueryResult } from '@tanstack/react-query'
import { fetchData } from '../client'
import type { RunEstimate } from '../types'

/** Cost estimate of a run, null where the run wrote none. */
async function fetchEstimate(runId: string): Promise<RunEstimate | null> {
  const { data, status } = await fetchData<RunEstimate>(`runs/${runId}/result.estimate.json`)
  if (!data) {
    if (status === 404) return null
    throw new Error(`Failed to fetch estimate: ${status}`)
  }
  return data
}

export function useEstimate(runId: string) {
  return useQuery({
    queryKey: ['run', runId, 'estimate'],
    queryFn: () => fetchEstimate(runId),
    enabled: !!runId,
  })
}

/** Module scoped, so the combined array keeps its identity between renders. */
const estimatePerRun = (results: UseQueryResult<RunEstimate | null>[]) => results.map((result) => result.data ?? null)

/** The estimates of the compared runs, in the order of the run ids, null where a run wrote none. */
export function useEstimates(runIds: string[]) {
  return useQueries({
    queries: runIds.map((runId) => ({
      queryKey: ['run', runId, 'estimate'],
      queryFn: () => fetchEstimate(runId),
      enabled: !!runId,
    })),
    combine: estimatePerRun,
  })
}

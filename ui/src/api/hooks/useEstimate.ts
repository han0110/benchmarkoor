import { useMemo } from 'react'
import { useQueries, useQuery, type QueryFunctionContext, type UseQueryResult } from '@tanstack/react-query'
import { fetchData, fetchViaS3 } from '../client'
import type { EstimateIndex, RunEstimate } from '../types'
import { hasDiscoveryMapping, isLocalMode, isS3Mode, loadRuntimeConfig, registerDiscoveryMapping, type RuntimeConfig } from '@/config/runtime'
import { useIndex } from './useIndex'

/** Reports whether the local or S3 mode routes each path through the discovery path of its id. */
const routesByDiscoveryPath = (config: RuntimeConfig) => (isS3Mode(config) || isLocalMode(config)) && !!config.api?.baseUrl

/** Reports whether a status means a missing file. S3 answers a read of a missing key with 403 when the signer cannot list the bucket. */
const isMissingFile = (config: RuntimeConfig, status: number) => status === 404 || (status === 403 && isS3Mode(config))

/** An estimate, null where the results hold none under the id. */
async function fetchEstimate(config: RuntimeConfig, estimateId: string): Promise<RunEstimate | null> {
  const { data, status } = await fetchData<RunEstimate>(`estimates/${estimateId}/result.estimate.json`)
  if (!data) {
    if (isMissingFile(config, status)) return null
    throw new Error(`Failed to fetch estimate: ${status}`)
  }
  return data
}

export const estimateQuery = (estimateId: string) => ({
  queryKey: ['estimate', estimateId],
  // The local and S3 modes wait for the index, which maps the id to its discovery path.
  queryFn: async ({ client }: QueryFunctionContext) => {
    const config = await loadRuntimeConfig()
    if (routesByDiscoveryPath(config)) {
      const { entries, failedPaths } = await client.ensureQueryData(estimateIndexQuery)
      // An id that no loaded path lists can be in a failed path, so the next attempt reads every path again.
      if (failedPaths.length > 0 && !entries.some((entry) => entry.estimate_id === estimateId)) {
        client.removeQueries({ queryKey: estimateIndexQuery.queryKey })
        throw new Error(`Failed to fetch estimate index: ${failedPaths.join(', ')}`)
      }
    }
    return fetchEstimate(config, estimateId)
  },
  enabled: !!estimateId,
})

export function useEstimate(estimateId: string) {
  return useQuery(estimateQuery(estimateId))
}

/** Module scoped, so the combined result keeps its identity between renders. */
const combineEstimates = (results: UseQueryResult<RunEstimate | null>[]) => ({
  estimates: results.map((result) => result.data ?? null),
  isPending: results.some((result) => result.isPending),
  error: results.find((result) => result.error)?.error ?? null,
})

/** The estimates of the ids, in the order of the ids, null where the results hold none. */
export function useEstimates(estimateIds: string[]) {
  return useQueries({
    queries: estimateIds.map(estimateQuery),
    combine: combineEstimates,
  })
}

/** The estimate index, with each discovery path whose index failed to load, named with the status or the error it gave. */
interface MergedEstimateIndex extends EstimateIndex {
  failedPaths: string[]
}

const emptyEstimateIndex: MergedEstimateIndex = { generated: 0, entries: [], failedPaths: [] }

/** The estimate index of one discovery path, null where the path holds none. It maps each estimate to the path, and each suite that has no path yet. */
async function fetchDiscoveryEstimateIndex(config: RuntimeConfig, discoveryPath: string): Promise<EstimateIndex | null> {
  const url = `${config.api!.baseUrl}/api/v1/files/${discoveryPath}/estimates/index.json`
  const response = isS3Mode(config) ? await fetchViaS3(url) : await fetch(url, { credentials: 'include' })
  if (isMissingFile(config, response.status)) return null
  if (!response.ok) throw new Error(String(response.status))
  // A server that answers a missing file with a page reads as 404, as in fetchData.
  if (!response.headers.get('content-type')?.includes('application/json')) return null
  const index: EstimateIndex = await response.json()
  for (const entry of index.entries) {
    registerDiscoveryMapping(entry.estimate_id, discoveryPath)
    // A suite keeps the root of the run index, which holds its stats.json.
    if (!hasDiscoveryMapping(entry.suite_hash)) registerDiscoveryMapping(entry.suite_hash, discoveryPath)
  }
  return index
}

/** The estimate index, empty where the results hold no estimates. In the local and S3 modes, it merges the index of each discovery path that loads, newest first. */
async function fetchEstimateIndex(): Promise<MergedEstimateIndex> {
  const config = await loadRuntimeConfig()
  if (routesByDiscoveryPath(config)) {
    const discoveryPaths = (isS3Mode(config) ? config.storage?.s3 : config.storage?.local)?.discovery_paths ?? []
    const results = await Promise.allSettled(discoveryPaths.map((discoveryPath) => fetchDiscoveryEstimateIndex(config, discoveryPath)))
    const indexes = results.flatMap((result) => (result.status === 'fulfilled' && result.value !== null ? [result.value] : []))
    return {
      generated: Math.max(0, ...indexes.map((index) => index.generated)),
      entries: indexes.flatMap((index) => index.entries).sort((a, b) => b.timestamp - a.timestamp),
      failedPaths: results.flatMap((result, at) => (result.status === 'rejected' ? [`${discoveryPaths[at]} (${result.reason.message})`] : [])),
    }
  }

  const { data, status } = await fetchData<EstimateIndex>('estimates/index.json')
  if (!data) {
    if (isMissingFile(config, status)) return emptyEstimateIndex
    throw new Error(`Failed to fetch estimate index: ${status}`)
  }
  return { ...data, failedPaths: [] }
}

const estimateIndexQuery = { queryKey: ['estimate-index'], queryFn: fetchEstimateIndex }

export function useEstimateIndex() {
  return useQuery(estimateIndexQuery)
}

/** Module scoped, so the set keeps its identity while the index stays the same. */
const selectEstimateIds = (index: EstimateIndex) => new Set(index.entries.map((entry) => entry.estimate_id))

export function useEstimateIds() {
  return useQuery({ ...estimateIndexQuery, select: selectEstimateIds })
}

/** The ids of the run index, undefined while the index loads. A run links to the estimate of the same name. */
export function useRunIds() {
  const { data: index } = useIndex()

  return useMemo(() => index && new Set(index.entries.map((entry) => entry.run_id)), [index])
}

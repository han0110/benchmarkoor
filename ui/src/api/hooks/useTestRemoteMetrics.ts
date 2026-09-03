import { useQuery } from '@tanstack/react-query'
import { fetchGzipJson } from '../client'
import type { TestRemoteMetrics } from '../types'

/** The remote metric traces of one test, absent from tests that collected none. */
export function useTestRemoteMetrics(runId: string, testName: string) {
  return useQuery({
    queryKey: ['run', runId, 'test', testName, 'remote-metrics'],
    queryFn: async () => {
      const { data, status } = await fetchGzipJson<TestRemoteMetrics>(`runs/${runId}/${testName}/test.remote-metrics.json.gz`)
      if (!data) {
        if (status === 404) return null
        throw new Error(`Failed to fetch remote metrics: ${status}`)
      }
      return data
    },
    enabled: !!runId && !!testName,
  })
}

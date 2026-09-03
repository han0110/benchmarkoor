import { useQuery } from '@tanstack/react-query'
import { fetchData } from '../client'
import type { DeviceMetrics } from '../types'

/** One artifact of remote metrics, absent from runs that collected none. */
function useRemoteMetrics(runId: string, file: string) {
  return useQuery({
    queryKey: ['run', runId, file],
    queryFn: async () => {
      const { data, status } = await fetchData<DeviceMetrics>(`runs/${runId}/${file}`)
      if (!data) {
        if (status === 404) return null
        throw new Error(`Failed to fetch ${file}: ${status}`)
      }
      return data
    },
    enabled: !!runId,
  })
}

export function useDeviceMetrics(runId: string) {
  return useRemoteMetrics(runId, 'result.device-metrics.json')
}

export function useNodeMetrics(runId: string) {
  return useRemoteMetrics(runId, 'result.node-metrics.json')
}

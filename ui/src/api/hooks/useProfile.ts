import { useQuery } from '@tanstack/react-query'
import { loadRuntimeConfig } from '@/config/runtime'
import { buildProfile } from '@/utils/pprof'
import { fetchData, fetchGzipBytes } from '../client'
import type { RunProfile } from '../types'
import { isMissingFile } from './useEstimate'

/** The profile of a run, null where the results hold none under the run id. */
export function useRunProfile(runId: string) {
  return useQuery({
    queryKey: ['profile', runId],
    queryFn: async () => {
      const { data, status } = await fetchData<RunProfile>(`profiles/${runId}/result.profile.json`)
      if (!data) {
        if (isMissingFile(await loadRuntimeConfig(), status)) return null
        throw new Error(`Failed to fetch profile: ${status}`)
      }
      return data
    },
    enabled: !!runId,
  })
}

/** The call tree of the pprof of one test, null where the run holds no pprof of the test. */
export function useTestProfile(runId: string, testName: string) {
  return useQuery({
    queryKey: ['profile', runId, 'test', testName],
    queryFn: async () => {
      const { data, status } = await fetchGzipBytes(`profiles/${runId}/${testName}/profile.pb.gz`)
      if (!data) {
        if (isMissingFile(await loadRuntimeConfig(), status)) return null
        throw new Error(`Failed to fetch pprof: ${status}`)
      }
      return buildProfile(data)
    },
    enabled: !!runId && !!testName,
  })
}

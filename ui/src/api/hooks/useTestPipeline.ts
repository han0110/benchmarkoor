import { useMemo } from 'react'
import { useQuery } from '@tanstack/react-query'
import { decodePipeline, type PipelineModel } from '@/utils/pipeline'
import { fetchGzipJson } from '../client'
import type { TestPipeline } from '../types'

/** The task timeline of one test, absent from tests the cluster did not prove. */
export function useTestPipeline(runId: string, testName: string) {
  return useQuery({
    queryKey: ['run', runId, 'test', testName, 'pipeline'],
    queryFn: async () => {
      const { data, status } = await fetchGzipJson<TestPipeline>(`runs/${runId}/${testName}/test.pipeline.json.gz`)
      if (!data) {
        if (status === 404) return null
        throw new Error(`Failed to fetch pipeline: ${status}`)
      }
      return data
    },
    enabled: !!runId && !!testName,
  })
}

/** The drawn model of one test with the sub step labels of its artifact. */
export interface TestPipelineView {
  model: PipelineModel
  breakdown: string[]
}

/** The pipeline of one test, null when the test carries no task to draw. */
export function useTestPipelineView(runId: string, testName: string): TestPipelineView | null {
  const { data } = useTestPipeline(runId, testName)

  return useMemo(() => {
    if (!data) return null
    const model = decodePipeline(data)

    return model.items.length === 0 ? null : { model, breakdown: data.breakdown }
  }, [data])
}

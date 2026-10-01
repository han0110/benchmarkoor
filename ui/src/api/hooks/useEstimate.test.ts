import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { QueryClient } from '@tanstack/react-query'
import type { EstimateIndex, EstimateIndexEntry } from '../types'

const entry = (estimateId: string, timestamp: number, suiteHash = 's1') => ({ estimate_id: estimateId, timestamp, suite_hash: suiteHash }) as EstimateIndexEntry

const estimate = { timestamp: 2 }

/** A local storage backend with three discovery paths, where the second path holds estimate b and the third holds no estimates. */
const files: Record<string, unknown> = {
  '/config.json': { dataSource: '/results', api: { baseUrl: 'http://api' } },
  'http://api/api/v1/config': { storage: { local: { enabled: true, discovery_paths: ['first', 'second', 'third'] } } },
  'http://api/api/v1/files/first/estimates/index.json': { generated: 1, entries: [entry('c', 3), entry('a', 1)] },
  'http://api/api/v1/files/second/estimates/index.json': { generated: 2, entries: [entry('b', 2, 's2')] },
  'http://api/api/v1/files/second/estimates/b/result.estimate.json': estimate,
}

/** An S3 backend, where the API presigns the file and the bucket answers the presigned read. */
const presigned = (path: string, body: unknown) => ({ [`http://api/api/v1/files/${path}`]: { url: `https://s3/${path}` }, [`https://s3/${path}`]: body })

/** Serves each file as JSON, a number as a response with that status, an error as a failed request, and a missing file as 404. */
function serve(served: Record<string, unknown>) {
  vi.stubGlobal(
    'fetch',
    vi.fn(async (url: string) => {
      const body = served[url.split('?')[0]]
      if (body instanceof Error) throw body
      if (typeof body === 'number') return new Response(null, { status: body })
      return body ? new Response(JSON.stringify(body), { headers: { 'content-type': 'application/json' } }) : new Response(null, { status: 404 })
    }),
  )
}

// The runtime module caches the config and the discovery path of each id, so each test imports it again.
beforeEach(() => {
  vi.resetModules()
})

afterEach(() => {
  vi.unstubAllGlobals()
})

describe('estimateQuery', () => {
  it('reads an estimate under the discovery path whose index lists it, and merges the indexes newest first', async () => {
    const { estimateQuery } = await import('./useEstimate')
    serve(files)
    const client = new QueryClient()

    expect(await client.fetchQuery(estimateQuery('b'))).toEqual(estimate)
    expect(client.getQueryData<EstimateIndex>(['estimate-index'])?.entries.map((entry) => entry.estimate_id)).toEqual(['c', 'b', 'a'])
  })

  it('reads an estimate of a healthy path while another path fails', async () => {
    const { estimateQuery } = await import('./useEstimate')
    serve({ ...files, 'http://api/api/v1/files/first/estimates/index.json': 500 })
    const client = new QueryClient()

    expect(await client.fetchQuery(estimateQuery('b'))).toEqual(estimate)
    expect(client.getQueryData(['estimate-index'])).toEqual({ generated: 2, entries: [entry('b', 2, 's2')], failedPaths: ['first (500)'] })
  })

  it('fails an id that no loaded path lists where a path failed, and finds no estimate where none failed', async () => {
    const { estimateQuery } = await import('./useEstimate')
    serve(files)
    expect(await new QueryClient().fetchQuery(estimateQuery('z'))).toBeNull()

    serve({ ...files, 'http://api/api/v1/files/first/estimates/index.json': 500, 'http://api/api/v1/files/third/estimates/index.json': new TypeError('Failed to fetch') })
    await expect(new QueryClient().fetchQuery(estimateQuery('z'))).rejects.toThrow('Failed to fetch estimate index: first (500), third (Failed to fetch)')
  })

  it('reads every path again after a failure, so an estimate loads once its path turns healthy', async () => {
    const { estimateQuery } = await import('./useEstimate')
    serve({ ...files, 'http://api/api/v1/files/second/estimates/index.json': 500 })
    const client = new QueryClient()
    await expect(client.fetchQuery(estimateQuery('b'))).rejects.toThrow('Failed to fetch estimate index: second (500)')

    serve(files)
    expect(await client.fetchQuery(estimateQuery('b'))).toEqual(estimate)
  })

  it('reads a 403 of the S3 mode as a path without estimates', async () => {
    const { estimateQuery } = await import('./useEstimate')
    serve({
      '/config.json': files['/config.json'],
      'http://api/api/v1/config': { storage: { s3: { enabled: true, discovery_paths: ['first', 'second'] } } },
      ...presigned('first/estimates/index.json', 403),
      ...presigned('second/estimates/index.json', { generated: 2, entries: [entry('b', 2)] }),
      ...presigned('second/estimates/b/result.estimate.json', estimate),
    })
    const client = new QueryClient()

    expect(await client.fetchQuery(estimateQuery('b'))).toEqual(estimate)
    expect(client.getQueryData(['estimate-index'])).toMatchObject({ failedPaths: [] })
  })

  it('reads a 403 of the S3 mode as a missing estimate', async () => {
    const { estimateQuery } = await import('./useEstimate')
    serve({
      '/config.json': files['/config.json'],
      'http://api/api/v1/config': { storage: { s3: { enabled: true, discovery_paths: ['first'] } } },
      ...presigned('first/estimates/z/result.estimate.json', 403),
    })

    expect(await new QueryClient().fetchQuery(estimateQuery('z'))).toBeNull()
  })

  it('reads an estimate of the static mode without the index', async () => {
    const { estimateQuery } = await import('./useEstimate')
    serve({ '/config.json': { dataSource: '/results' }, '/results/estimates/index.json': 500, '/results/estimates/b/result.estimate.json': estimate })
    const client = new QueryClient()

    expect(await client.fetchQuery(estimateQuery('b'))).toEqual(estimate)
    expect(client.getQueryState(['estimate-index'])).toBeUndefined()
  })

  it('maps a suite to the path of its estimate only where no path maps it yet', async () => {
    const { estimateQuery } = await import('./useEstimate')
    const { getDiscoveryPath, loadRuntimeConfig, registerDiscoveryMapping } = await import('@/config/runtime')
    serve(files)
    // The run index maps the suite to the root that holds its stats.json.
    registerDiscoveryMapping('s1', 'runs')

    await new QueryClient().fetchQuery(estimateQuery('b'))
    const config = await loadRuntimeConfig()

    expect(getDiscoveryPath('s1', config)).toBe('runs')
    expect(getDiscoveryPath('s2', config)).toBe('second')
  })
})

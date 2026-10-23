import { afterEach, describe, expect, it, vi } from 'vitest'
import { gzipSync } from 'node:zlib'
import { fetchGzipBytes, fetchGzipJson } from './client'

const document = { schemaVersion: 1, exporters: {} }

/** Serves the runtime config first, then the given body for every data request. */
function serve(body: BodyInit | null, status = 200) {
  vi.stubGlobal(
    'fetch',
    vi.fn(async (url: string) =>
      url.endsWith('config.json') ? new Response(JSON.stringify({ dataSource: '/results' })) : new Response(body, { status }),
    ),
  )
}

afterEach(() => {
  vi.unstubAllGlobals()
})

describe('fetchGzipJson', () => {
  it('inflates a gzip body', async () => {
    serve(new Uint8Array(gzipSync(JSON.stringify(document))))

    expect(await fetchGzipJson('runs/r/t/test.remote-metrics.json.gz')).toEqual({ data: document, status: 200 })
  })

  it('reads a body the server already inflated', async () => {
    serve(JSON.stringify(document))

    expect(await fetchGzipJson('runs/r/t/test.remote-metrics.json.gz')).toEqual({ data: document, status: 200 })
  })

  it('reports a missing file, also when the server answers with the page', async () => {
    serve(null, 404)
    expect(await fetchGzipJson('runs/r/t/test.remote-metrics.json.gz')).toEqual({ data: null, status: 404 })

    serve('<!doctype html>\n<html lang="en"></html>')
    expect(await fetchGzipJson('runs/r/t/test.remote-metrics.json.gz')).toEqual({ data: null, status: 404 })
  })
})

describe('fetchGzipBytes', () => {
  it('inflates a gzip body to bytes that are not text', async () => {
    const bytes = new Uint8Array([0x0a, 0xff, 0x00, 0x80])
    serve(new Uint8Array(gzipSync(bytes)))

    expect(await fetchGzipBytes('profiles/r/t/profile.pb.gz')).toEqual({ data: bytes, status: 200 })
  })
})

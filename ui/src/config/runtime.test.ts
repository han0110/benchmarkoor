import { describe, expect, it } from 'vitest'
import { getDataUrl, registerDiscoveryMapping, type RuntimeConfig } from './runtime'

/** A local storage backend with two discovery paths. */
const config: RuntimeConfig = {
  dataSource: '/results',
  api: { baseUrl: 'http://api' },
  storage: { s3: { enabled: false, discovery_paths: [] }, local: { enabled: true, discovery_paths: ['first', 'second'] } },
}

describe('getDataUrl', () => {
  it('reads the profile of a run under the discovery path of the run', () => {
    registerDiscoveryMapping('r1', 'second')

    expect(getDataUrl('profiles/r1/t/profile.pb.gz', config)).toBe('http://api/api/v1/files/second/profiles/r1/t/profile.pb.gz')
  })
})

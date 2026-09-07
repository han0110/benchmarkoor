import { describe, it, expect } from 'vitest'
import type { RunEstimate } from '@/api/types'
import {
  costKinds,
  costPoints,
  costShare,
  costTotal,
  fitted,
  formatCost,
  formatRate,
  sharedTestNames,
  type FitPoint,
} from './estimate'

const point = (cost: number, timeMs: number): FitPoint => ({ cost, timeMs })

const estimate = (tests: RunEstimate['tests']): RunEstimate => ({
  zkvm: 'openvm',
  image: 'ghcr.io/eth-act/ere/ere-server-openvm:0.18.0',
  elf_url: 'https://example.invalid/guest.elf',
  elf_sha256: '00',
  tests,
})

describe('costTotal', () => {
  const cases: { name: string; cost: Record<string, number>; want: number }[] = [
    { name: 'sums the kinds', cost: { precompile: 1, rv64: 2, system: 3 }, want: 6 },
    { name: 'reads a lone kind', cost: { base: 5 }, want: 5 },
  ]

  for (const { name, cost, want } of cases) {
    it(name, () => {
      expect(costTotal(cost)).toBe(want)
    })
  }
})

describe('costShare', () => {
  it('takes the kind against the total of the test', () => {
    expect(costShare({ rv64: 3, system: 1 }, 'rv64')).toBe(0.75)
    expect(costShare({ rv64: 3, system: 1 }, 'precompile')).toBe(0)
  })

  it('states no share where the test costs nothing', () => {
    expect(costShare({ rv64: 0 }, 'rv64')).toBeUndefined()
  })
})

describe('costKinds', () => {
  it('lists every kind in the order they are first seen', () => {
    const runs = [estimate({ a: { cost: { rv64: 2, precompile: 1 } } }), estimate({ a: { cost: { rv64: 2, system: 4 } } })]
    expect(costKinds(runs)).toEqual(['rv64', 'precompile', 'system'])
  })
})

describe('sharedTestNames', () => {
  it('keeps the tests every run estimated', () => {
    const runs = [
      estimate({ b: { cost: { rv64: 1 } }, a: { cost: { rv64: 1 } }, c: { cost: { rv64: 1 } } }),
      estimate({ a: { cost: { rv64: 1 } }, b: { cost: { rv64: 1 } } }),
    ]
    expect(sharedTestNames(runs)).toEqual(['a', 'b'])
  })
})

describe('fitted', () => {
  it('recovers a line every test sits on', () => {
    const points = [point(1, 3), point(2, 5), point(3, 7)]
    for (const model of ['least-squares', 'relative-squares'] as const) {
      const fit = fitted(points, model)
      expect(fit.slope).toBeCloseTo(2, 10)
      expect(fit.intercept).toBeCloseTo(1, 10)
      expect(fit.determination).toBeCloseTo(1, 10)
      for (const value of fit.deviations) expect(value).toBeCloseTo(0, 10)
    }
  })

  // Three short tests beside one that runs 500 times longer, the shape the two models part over.
  const spanning = [point(1, 10), point(2, 20), point(3, 30), point(1000, 5000)]

  it('weights a test by how long it runs under least squares', () => {
    const fit = fitted(spanning, 'least-squares')
    expect(fit.slope).toBeCloseTo(4.98999337353833, 10)
    expect(fit.intercept).toBeCloseTo(10.01666655510985, 10)
    expect(fit.determination).toBeCloseTo(0.999997301122701, 10)
    // The longest test fits to within a millionth. The shortest sits half its own time from the line.
    expect(fit.deviations[0]).toBeCloseTo(-0.5006659928648179, 10)
    expect(fit.deviations[3]).toBeCloseTo(-2.0080186879567917e-6, 10)
  })

  it('gives every test one voice under relative least squares', () => {
    const fit = fitted(spanning, 'relative-squares')
    expect(fit.slope).toBeCloseTo(5.581030148257909, 10)
    expect(fit.intercept).toBeCloseTo(5.950356837188658, 10)
    expect(fit.determination).toBeCloseTo(0.9814730688768998, 10)
    for (const value of fit.deviations) expect(Math.abs(value)).toBeLessThan(0.25)
  })

  it('draws a flat line through a lone point under either model', () => {
    for (const model of ['least-squares', 'relative-squares'] as const) {
      const fit = fitted([point(7, 250)], model)
      expect(fit.slope).toBe(0)
      expect(fit.predicted(7)).toBeCloseTo(250, 10)
      expect(fit.deviations[0]).toBeCloseTo(0, 10)
    }
  })
})

describe('costPoints', () => {
  const priced = estimate({
    late: { cost: { rv64: 3 } },
    unlisted: { cost: { rv64: 2 } },
    early: { cost: { rv64: 1, precompile: 2 }, peak_heap_bytes: 4096 },
  })
  const kinds = ['rv64', 'precompile']
  const suiteTests = [{ name: 'early' }, { name: 'late' }]

  it('prices the tests in the order the suite ran them, the ones it does not list going last', () => {
    const points = costPoints(priced, kinds, { suiteTests })

    expect(points.map((point) => point.testName)).toEqual(['early', 'late', 'unlisted'])
    expect(points.map((point) => point.testNumber)).toEqual([1, 2, 3])
    expect(points[0]).toMatchObject({ testIndex: 1, costs: [1, 2], total: 3, peakHeapBytes: 4096 })
    expect(points[1].peakHeapBytes).toBeNull()
  })

  it('prices only the tests the page filters keep', () => {
    expect(costPoints(priced, kinds, { searchQuery: 'late' }).map((point) => point.testName)).toEqual(['late'])
    expect(costPoints(priced, kinds, { includeTest: (name) => name === 'early' }).map((point) => point.testName)).toEqual(['early'])
    expect(costPoints(priced, kinds).map((point) => point.testName)).toEqual(['early', 'late', 'unlisted'])
  })
})

describe('formatCost', () => {
  const cases: [number, string][] = [
    [3.5e12, '3.50T'],
    [12_345_678_901, '12.35G'],
    [2_500_000, '2.50M'],
    [1500, '1.50k'],
    [999, '999'],
    [-2_000_000, '-2.00M'],
  ]

  for (const [value, want] of cases) {
    it(`prints ${want}`, () => {
      expect(formatCost(value)).toBe(want)
    })
  }
})

describe('formatRate', () => {
  it('states the seconds a billion of cost takes', () => {
    expect(formatRate(8.4e-8)).toBe('0.084 s/G')
    expect(formatRate(2e-6)).toBe('2.000 s/G')
  })
})

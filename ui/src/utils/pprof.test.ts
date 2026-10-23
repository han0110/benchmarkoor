import { describe, expect, it } from 'vitest'
import { Profile, StringTable, type SampleInput } from 'pprof-format'
import { buildProfile, fnvHash, layoutFlame, matchedTotal, sandwichOf, similarToParent, type CallNode } from './pprof'

/** A cost past 32 bits, as the cells of a large block are. */
const BIG = 2 ** 33 + 1

/**
 * Encodes a pprof with the calls and cost sample types and one function per name.
 * Location 10 * n has one line in function n, so that a location id read as a
 * function id fails the tests.
 */
function encodePprof(names: string[], samples: SampleInput[] = []): Uint8Array {
  const stringTable = new StringTable()
  return new Profile({
    sampleType: [
      { type: stringTable.dedup('calls'), unit: stringTable.dedup('count') },
      { type: stringTable.dedup('cost'), unit: stringTable.dedup('cells') },
    ],
    sample: samples,
    location: names.map((_, index) => ({ id: 10 * (index + 1), line: [{ functionId: index + 1 }] })),
    function: names.map((name, index) => ({ id: index + 1, name: stringTable.dedup(name) })),
    stringTable,
  }).encode()
}

// Main calls f, f calls g, and g calls f again under a second function named f.
// Main also calls g, and the [base] frame of the zkVM has no caller. Each sample
// lists its locations leaf first.
const profile = buildProfile(
  encodePprof(['main', 'f', 'g', '[base]', 'f'], [
    { locationId: [30, 20, 10], value: [1, 10] },
    { locationId: [50, 30, 20, 10], value: [1, BIG] },
    { locationId: [40], value: [0, 7] },
    { locationId: [30, 10], value: [2, 5] },
  ]),
)

/** The frames from the root to the node, joined by semicolons. */
const pathOf = (node: number): string =>
  node === 0 ? '' : [pathOf(profile.nodes[node].parent), profile.names[profile.nodes[node].fn]].filter(Boolean).join(';')

describe('buildProfile', () => {
  it('reads the name, the unit, and the kind of each sample type', () => {
    expect(profile.types).toEqual([
      { name: 'calls', unit: 'count', kind: 'calls' },
      { name: 'cost', unit: 'cells', kind: 'cost' },
    ])
  })

  it('builds the call tree from the root, with the total and the self of every path per sample type', () => {
    expect(Object.fromEntries(profile.nodes.map((node, index) => [pathOf(index), [...node.total, ...node.self]]))).toEqual({
      '': [4, BIG + 22, 0, 0],
      main: [4, BIG + 15, 0, 0],
      'main;f': [2, BIG + 10, 0, 0],
      'main;f;g': [2, BIG + 10, 1, 10],
      'main;f;g;f': [1, BIG, 1, BIG],
      'main;g': [2, 5, 2, 5],
      '[base]': [0, 7, 0, 7],
    })
    expect(profile.totalType).toBe(1)
    expect(profile.sampleCount).toBe(4)
  })

  it('rejects a pprof without the cost sample type, such as an empty body', () => {
    expect(() => buildProfile(new Uint8Array())).toThrow('The pprof has no cost sample type')
  })

  it('merges the functions of one name, and counts a recursive function once per path', () => {
    expect(profile.names).toEqual(['main', 'f', 'g', '[base]'])
    expect(profile.fnTotal.map((values) => values[1])).toEqual([BIG + 15, BIG + 10, BIG + 15, 7])
    expect(profile.fnSelf.map((values) => values[1])).toEqual([0, BIG, 15, 7])
  })
})

describe('matchedTotal', () => {
  it('counts the total of a matched frame once, also where a matched frame calls it', () => {
    const matched = profile.names.map((name) => name === 'f' || name === 'g')

    expect(matchedTotal(profile, matched, 1)).toBe(BIG + 15)
  })
})

describe('similarToParent', () => {
  /** Whether each node continues the group of its parent, keyed by the name of its function, with root for node 0. */
  const similarByName = (names: string[], tree: CallNode[], type: number) => {
    const similar = similarToParent(tree, type)
    return Object.fromEntries(tree.map((node, index) => [node.fn < 0 ? 'root' : names[node.fn], similar[index]]))
  }

  it('continues the group of the parent at a single child above 99% of the parent', () => {
    // The root calls a, p, and u. In the chain a>b>c, b and c are single children above 99%.
    // The frame p calls q, r, and s, and v is the single child of u at 99%.
    const chains = buildProfile(
      encodePprof(['a', 'b', 'c', 'p', 'q', 'r', 's', 'u', 'v'], [
        { locationId: [30, 20, 10], value: [1, 995] },
        { locationId: [20, 10], value: [1, 3] },
        { locationId: [10], value: [1, 2] },
        { locationId: [50, 40], value: [1, 998] },
        { locationId: [60, 40], value: [1, 1] },
        { locationId: [70, 40], value: [1, 1] },
        { locationId: [90, 80], value: [1, 990] },
        { locationId: [80], value: [1, 10] },
      ]),
    )

    expect(similarByName(chains.names, chains.nodes, 1)).toEqual({ root: false, a: false, b: true, c: true, p: false, q: false, r: false, s: false, u: false, v: false })
  })

  it('reads the rule on the sample type, and a type with zero on both frames does not continue', () => {
    // Main calls f, and f calls g. Only main has a cost, so f and g have zero cost.
    const typed = buildProfile(
      encodePprof(['main', 'f', 'g'], [
        { locationId: [30, 20, 10], value: [1, 0] },
        { locationId: [10], value: [0, 100] },
      ]),
    )

    expect(similarByName(typed.names, typed.nodes, 0)).toEqual({ root: false, main: true, f: true, g: true })
    expect(similarByName(typed.names, typed.nodes, 1)).toEqual({ root: false, main: true, f: false, g: false })
  })

  it('lets the root start a group', () => {
    const single = buildProfile(encodePprof(['main'], [{ locationId: [10], value: [1, 1] }]))

    expect(similarToParent(single.nodes, 1)).toEqual([false, true])
  })
})

describe('sandwichOf', () => {
  // The sample paths are main>f>f, main>f>b>f>a>f, main>f>a>f>b, main>h>f, and main>h>a, so f calls itself at several depths.
  const recursive = buildProfile(
    encodePprof(['main', 'f', 'a', 'b', 'h'], [
      { locationId: [20, 20, 10], value: [1, 3] },
      { locationId: [20, 30, 20, 40, 20, 10], value: [1, 11] },
      { locationId: [40, 20, 30, 20, 10], value: [1, 13] },
      { locationId: [20, 50, 10], value: [1, 17] },
      { locationId: [30, 50, 10], value: [1, 19] },
    ]),
  )
  const { callers, callees } = sandwichOf(recursive, recursive.names.indexOf('f'))

  /** The total and the self cost of each node of the tree, keyed by the names from node 0 joined by the separator. */
  const costByPath = (names: string[], tree: CallNode[], separator: string) => {
    const pathOf = (node: number): string => (node === 0 ? names[tree[0].fn] : `${pathOf(tree[node].parent)}${separator}${names[tree[node].fn]}`)
    return Object.fromEntries(tree.map((node, index) => [pathOf(index), [node.total[1], node.self[1]]]))
  }

  it('merges the callers of every call site, and counts a recursive call once', () => {
    expect(costByPath(recursive.names, callers, '<')).toEqual({ f: [44, 0], 'f<main': [27, 27], 'f<h': [17, 0], 'f<h<main': [17, 17] })
  })

  it('merges the callees of every call site by function at each depth', () => {
    expect(costByPath(recursive.names, callees, '>')).toEqual({
      f: [44, 17],
      'f>f': [3, 3],
      'f>b': [11, 0],
      'f>b>f': [11, 0],
      'f>b>f>a': [11, 0],
      'f>b>f>a>f': [11, 11],
      'f>a': [13, 0],
      'f>a>f': [13, 0],
      'f>a>f>b': [13, 13],
    })
  })

  it('gives a function only at the root no callers', () => {
    expect(costByPath(profile.names, sandwichOf(profile, profile.names.indexOf('[base]')).callers, '<')).toEqual({ '[base]': [7, 7] })
  })

  it('roots both trees at the total of the function for every sample type', () => {
    for (const built of [profile, recursive]) {
      built.names.forEach((_, fn) => {
        const sandwich = sandwichOf(built, fn)
        expect([sandwich.callers[0].total, sandwich.callees[0].total]).toEqual([built.fnTotal[fn], built.fnTotal[fn]])
      })
    }
  })
})

describe('layoutFlame', () => {
  // The root calls f, e, and a in this order, a calls b, and b calls d and c. The frame f calls g.
  // The root has a cost of 256 cells, so at 64 pixels f and g are 0.25 pixels wide.
  const tree = buildProfile(
    encodePprof(['a', 'b', 'c', 'd', 'e', 'f', 'g'], [
      { locationId: [70, 60], value: [1, 1] },
      { locationId: [50], value: [1, 127] },
      { locationId: [40, 20, 10], value: [1, 32] },
      { locationId: [30, 20, 10], value: [1, 96] },
    ]),
  )
  const b = tree.nodes.findIndex(({ fn }) => tree.names[fn] === 'b')
  const layout = (zoom: number, collapsed = false) => layoutFlame(tree.nodes, 1, zoom, 64, similarToParent(tree.nodes, 1), collapsed)

  /** The rows of a layout, and each frame as the names of its chain joined by `>`, its x, its width, and its row. */
  const frames = ({ rects, rows }: ReturnType<typeof layout>) => ({
    rows,
    frames: rects.map(({ chain, x, width, row }) => [chain.map((node) => (node === 0 ? 'root' : tree.names[tree.nodes[node].fn])).join('>'), x, width, row]),
  })

  it('places the callees of a frame on the next row, the widest first, and leaves out a frame narrower than 0.4 pixels with its callees', () => {
    expect(frames(layout(0))).toEqual({ rows: 4, frames: [['root', 0, 64, 0], ['a', 0, 32, 1], ['b', 0, 32, 2], ['c', 0, 24, 3], ['d', 24, 8, 3], ['e', 32, 31.75, 1]] })
  })

  it('draws the ancestors of the zoomed frame above it, one row each, and spans them and the zoomed frame over the full width', () => {
    const zoomed = layout(b)

    expect(frames(zoomed)).toEqual({ rows: 4, frames: [['root', 0, 64, 0], ['a', 0, 64, 1], ['b', 0, 64, 2], ['c', 0, 48, 3], ['d', 48, 16, 3]] })
    expect(zoomed.rects.map(({ ancestor }) => ancestor)).toEqual([true, true, false, false, false])
  })

  it('folds a chain of similar frames into one row above the callees of its last frame, but never folds the zoomed frame', () => {
    expect(frames(layout(0, true))).toEqual({ rows: 3, frames: [['root', 0, 64, 0], ['a>b', 0, 32, 1], ['c', 0, 24, 2], ['d', 24, 8, 2], ['e', 32, 31.75, 1]] })
    expect(layout(b, true)).toEqual(layout(b))
  })
})

describe('fnvHash', () => {
  it('divides the FNV-1a 64 hash of the name by the largest u64, as an f32', () => {
    // The FNV-1a 64 hash of `a` is 0xaf63dc4c8601ec8c, the standard test vector.
    expect(fnvHash('a')).toBe(Math.fround(Number(0xaf63dc4c8601ec8cn) / Number(2n ** 64n - 1n)))
  })
})

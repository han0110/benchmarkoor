import { Profile as PprofProfile } from 'pprof-format'

/** A sample type of a profile. Cost is the zkVM unit, such as cells, and heap growth is bytes. */
export interface SampleType {
  name: string
  unit: string
  kind: 'calls' | 'heap' | 'cost'
}

/** One call path. Node 0 is the root, which has no function. */
export interface CallNode {
  /** Index of the function in the names of the profile, -1 at the root. */
  fn: number
  /** Index of the caller node, -1 at the root. */
  parent: number
  children: number[]
  /** Value of the path and its callees, per sample type. */
  total: Float64Array
  /** Value of the path alone, per sample type. */
  self: Float64Array
}

/** The call tree of a profile, with the value of each function per sample type. */
export interface Profile {
  types: SampleType[]
  /** Index of the cost type, the sum of the cost components. */
  totalType: number
  /** Function names, one per frame, as frames merge by name. */
  names: string[]
  nodes: CallNode[]
  fnSelf: Float64Array[]
  /** Value of each function with its callees. A recursive function counts once per path. */
  fnTotal: Float64Array[]
  sampleCount: number
}

/** The FNV-1a 64 hash of the UTF-8 bytes of a name over the largest u64, as an f32, which inferno with `--deterministic` gives as v1 of the frame color (https://github.com/jonhoo/inferno/blob/v0.12.8/src/flamegraph/color/mod.rs#L377-L387). */
export function fnvHash(name: string): number {
  let hash = 0xcbf29ce484222325n
  for (const byte of new TextEncoder().encode(name)) hash = BigInt.asUintN(64, (hash ^ BigInt(byte)) * 0x100000001b3n)
  return Math.fround(Number(hash) / Number(2n ** 64n - 1n))
}

/** Adds each value of source to target. */
function addInto(target: Float64Array, source: ArrayLike<number>) {
  for (let type = 0; type < target.length; type++) target[type] += source[type]
}

/** A call tree from node 0 of rootFn. childOf gives the child of a node for a function, and adds the child where it is missing. */
function callTree(rootFn: number, typeCount: number) {
  const newNode = (fn: number, parent: number): CallNode => ({ fn, parent, children: [], total: new Float64Array(typeCount), self: new Float64Array(typeCount) })
  const nodes = [newNode(rootFn, -1)]
  const childIndex = [new Map<number, number>()]
  const childOf = (parent: number, fn: number) => {
    let child = childIndex[parent].get(fn)
    if (child === undefined) {
      child = nodes.length
      nodes.push(newNode(fn, parent))
      childIndex.push(new Map())
      childIndex[parent].set(fn, child)
      nodes[parent].children.push(child)
    }
    return child
  }
  return { nodes, childOf }
}

/** Decodes a pprof and builds its call tree from the root, merging frames by function name. */
export function buildProfile(bytes: Uint8Array): Profile {
  const pprof = PprofProfile.decode(bytes)
  const { strings } = pprof.stringTable
  const types = pprof.sampleType.map(({ type, unit }): SampleType => {
    const name = strings[Number(type)]
    return { name, unit: strings[Number(unit)], kind: name === 'calls' ? 'calls' : name === 'heap_growth' ? 'heap' : 'cost' }
  })
  const totalType = types.findIndex((type) => type.name === 'cost')
  if (totalType < 0) throw new Error('The pprof has no cost sample type')
  const functions = new Map(pprof.function.map(({ id, name }) => [Number(id), strings[Number(name)]]))
  const names: string[] = []
  const nameIndex = new Map<string, number>()
  const functionOf = new Map<number, number>()
  for (const { id, line } of pprof.location) {
    const name = functions.get(Number(line[0]?.functionId)) || '[unknown]'
    if (!nameIndex.has(name)) {
      nameIndex.set(name, names.length)
      names.push(name)
    }
    functionOf.set(Number(id), nameIndex.get(name)!)
  }
  const { nodes, childOf } = callTree(-1, types.length)
  for (const sample of pprof.sample) {
    const values = sample.value.map(Number)
    let node = 0
    addInto(nodes[node].total, values)
    for (let i = sample.locationId.length - 1; i >= 0; i--) {
      node = childOf(node, functionOf.get(Number(sample.locationId[i]))!)
      addInto(nodes[node].total, values)
    }
    addInto(nodes[node].self, values)
  }
  const fnSelf = names.map(() => new Float64Array(types.length))
  const fnTotal = names.map(() => new Float64Array(types.length))
  // How often each function occurs on the walked path, so a recursive call adds no total.
  const onPath = new Int32Array(names.length)
  const stack: Array<[node: number, exiting: boolean]> = [[0, false]]
  while (stack.length > 0) {
    const [node, exiting] = stack.pop()!
    const { fn, children, total, self } = nodes[node]
    if (exiting) {
      if (fn >= 0) onPath[fn]--
      continue
    }
    if (fn >= 0) {
      addInto(fnSelf[fn], self)
      if (onPath[fn] === 0) addInto(fnTotal[fn], total)
      onPath[fn]++
    }
    stack.push([node, true])
    for (const child of children) stack.push([child, false])
  }
  return {
    types,
    totalType,
    names,
    nodes,
    fnSelf,
    fnTotal,
    sampleCount: pprof.sample.length,
  }
}

/** The value of the matched frames with their callees. A matched frame below another matched frame adds nothing, as the total of that frame holds it. */
export function matchedTotal(profile: Profile, matched: boolean[], type: number): number {
  let sum = 0
  const stack = [0]
  while (stack.length > 0) {
    const { fn, total, children } = profile.nodes[stack.pop()!]
    if (fn >= 0 && matched[fn]) sum += total[type]
    else stack.push(...children)
  }
  return sum
}

/** The share of its parent that a single child must pass to continue the group of the parent, as in Grafana (https://github.com/grafana/grafana/blob/v13.2.3/packages/grafana-flamegraph/src/FlameGraph/dataTransform.ts#L190). */
const COLLAPSING_THRESHOLD = 0.99

/** Whether each node continues the group of similar frames of its parent. Node 0 has no parent, but it can start a group. */
export function similarToParent(nodes: CallNode[], type: number): boolean[] {
  return nodes.map(({ parent, total }) => parent >= 0 && nodes[parent].children.length === 1 && total[type] > nodes[parent].total[type] * COLLAPSING_THRESHOLD)
}

/** The callers and the callees of one function. Node 0 of each tree is the function. */
export interface Sandwich {
  /** The callers of the function, merged over its call sites. The children of a node are its callers. */
  callers: CallNode[]
  /** The callees of the function, merged over its call sites. */
  callees: CallNode[]
}

/**
 * The callers and the callees of fn, merged by function at each depth over the
 * call sites of fn. A call site is a node of fn with no fn above it, so a
 * recursive call counts once and shows only in the callees. The callers stop
 * below the root frame.
 */
export function sandwichOf(profile: Profile, fn: number): Sandwich {
  const { nodes, types } = profile
  const callers = callTree(fn, types.length)
  const callees = callTree(fn, types.length)
  nodes.forEach((site, siteNode) => {
    if (site.fn !== fn) return
    const chain: number[] = []
    for (let at = site.parent; at > 0; at = nodes[at].parent) {
      if (nodes[at].fn === fn) return
      chain.push(nodes[at].fn)
    }
    let caller = 0
    addInto(callers.nodes[caller].total, site.total)
    for (const callerFn of chain) {
      caller = callers.childOf(caller, callerFn)
      addInto(callers.nodes[caller].total, site.total)
    }
    // The path of the call site starts at this caller, so the caller keeps the value as self.
    addInto(callers.nodes[caller].self, site.total)
    const stack: Array<[source: number, target: number]> = [[siteNode, 0]]
    while (stack.length > 0) {
      const [source, target] = stack.pop()!
      addInto(callees.nodes[target].total, nodes[source].total)
      addInto(callees.nodes[target].self, nodes[source].self)
      for (const child of nodes[source].children) stack.push([child, callees.childOf(target, nodes[child].fn)])
    }
  })
  return { callers: callers.nodes, callees: callees.nodes }
}

/** The nodes from the root to the node, empty for the parent of the root. */
export function pathTo(nodes: CallNode[], node: number): number[] {
  const path: number[] = []
  for (let at = node; at !== -1; at = nodes[at].parent) path.unshift(at)
  return path
}

/** One drawn frame. An ancestor of the zoomed frame spans the full width. */
export interface FrameRect {
  node: number
  /** The nodes in the row, the drawn node first. */
  chain: number[]
  x: number
  width: number
  row: number
  ancestor: boolean
}

/**
 * layoutFlame places the zoomed frame and its callees below the ancestors of
 * the zoomed frame, the widest callee first. A frame narrower than 0.4 pixels
 * is left out. When groups collapse, a frame that continues the group of its
 * parent folds into the row of its parent, except the zoomed frame.
 */
export function layoutFlame(nodes: CallNode[], type: number, zoom: number, width: number, similar: boolean[], collapsed: boolean) {
  const folds = (node: number) => collapsed && similar[node]
  const rects: FrameRect[] = []
  for (const node of pathTo(nodes, nodes[zoom].parent)) {
    if (folds(node)) rects[rects.length - 1].chain.push(node)
    else rects.push({ node, chain: [node], x: 0, width, row: rects.length, ancestor: true })
  }
  const ancestorRows = rects.length
  const scale = width / Math.max(nodes[zoom].total[type], 1)
  let rows = ancestorRows + 1
  const walk = (node: number, x: number, row: number) => {
    const chain = [node]
    for (let next = nodes[node].children[0]; next !== undefined && folds(next); next = nodes[next].children[0]) chain.push(next)
    rects.push({ node, chain, x, width: nodes[node].total[type] * scale, row, ancestor: false })
    rows = Math.max(rows, row + 1)
    let offset = x
    for (const child of [...nodes[chain[chain.length - 1]].children].sort((a, b) => nodes[b].total[type] - nodes[a].total[type])) {
      const childWidth = nodes[child].total[type] * scale
      if (childWidth >= 0.4) walk(child, offset, row + 1)
      offset += childWidth
    }
  }
  if (nodes[zoom].total[type] > 0) walk(zoom, 0, ancestorRows)
  return { rects, rows }
}

/** The node envelope (§3.1), snapshots with derived inbound edges, and diffs keyed by id (§6.1). */

export type Json = null | boolean | number | string | ReadonlyArray<Json> | { readonly [k: string]: Json }

export interface Edge {
  readonly type: string
  readonly to: string
  readonly props?: Readonly<Record<string, Json>>
}

export interface Node {
  readonly id: string
  readonly type: string
  readonly props: Readonly<Record<string, Json>>
  readonly edges: ReadonlyArray<Edge>
}

export const ID = /^[A-Za-z0-9._-]+$/

export interface InEdge {
  readonly from: string
  readonly edge: Edge
}

export interface Snapshot {
  readonly nodes: ReadonlyMap<string, Node>
  readonly inbound: ReadonlyMap<string, ReadonlyArray<InEdge>>
  /** Ids whose files exist but failed to load: never allocated again, never overwritten (§15). */
  readonly reserved: ReadonlySet<string>
}

export type Change = { readonly op: "put"; readonly node: Node } | { readonly op: "remove"; readonly id: string }
export const Put = (node: Node): Change => ({ op: "put", node })
export const Remove = (id: string): Change => ({ op: "remove", id })
export const changedId = (c: Change) => (c.op === "put" ? c.node.id : c.id)

export const make = (nodes: Iterable<Node>, reserved: ReadonlySet<string> = new Set()): Snapshot => {
  const byId = new Map<string, Node>()
  for (const n of nodes) byId.set(n.id, n)
  const inbound = new Map<string, Array<InEdge>>()
  for (const n of byId.values())
    for (const edge of n.edges) {
      const list = inbound.get(edge.to) ?? []
      list.push({ from: n.id, edge })
      inbound.set(edge.to, list)
    }
  return { nodes: byId, inbound, reserved }
}

export const empty: Snapshot = make([])

export const applyChanges = (snap: Snapshot, changes: ReadonlyArray<Change>): Snapshot => {
  const next = new Map(snap.nodes)
  for (const c of changes) {
    if (c.op === "put") next.set(c.node.id, c.node)
    else next.delete(c.id)
  }
  return make(next.values(), snap.reserved)
}

export const byType = (snap: Snapshot, type: string): ReadonlyArray<Node> =>
  [...snap.nodes.values()].filter((n) => n.type === type).sort((a, b) => a.id.localeCompare(b.id))

export const out = (snap: Snapshot, id: string, type?: string): ReadonlyArray<Edge> =>
  (snap.nodes.get(id)?.edges ?? []).filter((e) => type === undefined || e.type === type)

export const inbound = (snap: Snapshot, id: string, type?: string): ReadonlyArray<InEdge> =>
  (snap.inbound.get(id) ?? []).filter((e) => type === undefined || e.edge.type === type)

export const danglingEdges = (snap: Snapshot): ReadonlyArray<InEdge> =>
  [...snap.nodes.values()].flatMap((n) => n.edges.filter((e) => !snap.nodes.has(e.to)).map((edge) => ({ from: n.id, edge })))

/** Next free id for a prefix, counting reserved ids: `ST` gives `ST-0006` when `ST-0005` is the highest. */
export const nextId = (snap: Snapshot, prefix: string): string => {
  let max = 0
  const re = new RegExp(`^${prefix}-(\\d+)$`)
  for (const id of [...snap.nodes.keys(), ...snap.reserved]) {
    const m = re.exec(id)
    if (m?.[1] !== undefined) max = Math.max(max, Number(m[1]))
  }
  return `${prefix}-${String(max + 1).padStart(4, "0")}`
}

/** Grouping and attribution edges: a walk follows them backward only from where it starts (§6.1). */
const ONE_WAY = new Set(["gherkin/by", "gherkin/in"])

/** Node ids within k hops, both directions (one-way edges only forward, except from `id`). Includes `id`. */
export const neighbors = (snap: Snapshot, id: string, k: number): ReadonlyArray<string> => {
  const seen = new Set([id])
  let frontier = [id]
  for (let i = 0; i < k && frontier.length > 0; i++) {
    const next: Array<string> = []
    for (const cur of frontier) {
      const adj = [...out(snap, cur).map((e) => e.to), ...inbound(snap, cur).filter((e) => cur === id || !ONE_WAY.has(e.edge.type)).map((e) => e.from)]
      for (const n of adj)
        if (snap.nodes.has(n) && !seen.has(n)) {
          seen.add(n)
          next.push(n)
        }
    }
    frontier = next
  }
  return [...seen].sort()
}

const sortKeys = (v: unknown): unknown =>
  Array.isArray(v)
    ? v.map(sortKeys)
    : v !== null && typeof v === "object"
      ? Object.fromEntries(Object.keys(v).sort().map((k) => [k, sortKeys((v as Record<string, unknown>)[k])]))
      : v

/** The file form (§15): keys sorted at every depth, arrays in order, two-space indent, trailing newline. */
export const canonical = (node: Node): string => `${JSON.stringify(sortKeys(node), null, 2)}\n`
/** Compact JSON with keys sorted at every depth: the input of a version fingerprint. */
export const canonicalJson = (v: unknown): string => JSON.stringify(sortKeys(v))

export interface EdgeDiff {
  readonly added: ReadonlyArray<Edge>
  readonly removed: ReadonlyArray<Edge>
}
export interface NodeChange {
  readonly id: string
  readonly before: Node
  readonly after: Node
  readonly edges: EdgeDiff
}
export interface Diff {
  readonly added: ReadonlyArray<Node>
  readonly removed: ReadonlyArray<Node>
  readonly changed: ReadonlyArray<NodeChange>
}

const edgeKey = (e: Edge) => `${e.type}\u0000${e.to}`

/** Nodes matched by id, edges by (type, to). */
export const diff = (before: Snapshot, after: Snapshot): Diff => {
  const added: Array<Node> = []
  const removed: Array<Node> = []
  const changed: Array<NodeChange> = []
  for (const [id, a] of after.nodes) {
    const b = before.nodes.get(id)
    if (b === undefined) added.push(a)
    else if (canonical(a) !== canonical(b)) {
      const bk = new Set(b.edges.map(edgeKey))
      const ak = new Set(a.edges.map(edgeKey))
      changed.push({ id, before: b, after: a, edges: { added: a.edges.filter((e) => !bk.has(edgeKey(e))), removed: b.edges.filter((e) => !ak.has(edgeKey(e))) } })
    }
  }
  for (const [id, b] of before.nodes) if (!after.nodes.has(id)) removed.push(b)
  const byId = (x: { id: string }, y: { id: string }) => x.id.localeCompare(y.id)
  return { added: added.sort(byId), removed: removed.sort(byId), changed: changed.sort(byId) }
}

export const isEmptyDiff = (d: Diff) => d.added.length === 0 && d.removed.length === 0 && d.changed.length === 0

/** Why `v` is not a node envelope, or undefined. */
export const envelopeProblem = (v: unknown): string | undefined => {
  if (v === null || typeof v !== "object" || Array.isArray(v)) return "not an object"
  const n = v as Record<string, unknown>
  if (typeof n.id !== "string" || !ID.test(n.id)) return `id ${JSON.stringify(n.id)} does not match ${ID}`
  if (typeof n.type !== "string" || !n.type.includes("/")) return `${n.id}: type ${JSON.stringify(n.type)} is not <namespace>/<kind>`
  if (n.props === null || typeof n.props !== "object" || Array.isArray(n.props)) return `${n.id}: props is not an object`
  if (!Array.isArray(n.edges)) return `${n.id}: edges is not an array`
  for (const e of n.edges as Array<Record<string, unknown>>) {
    if (e === null || typeof e !== "object") return `${n.id}: an edge is not an object`
    if (typeof e.type !== "string") return `${n.id}: an edge has no type`
    if (typeof e.to !== "string" || !ID.test(e.to)) return `${n.id}: edge ${e.type} points at an invalid id ${JSON.stringify(e.to)}`
    if (e.props !== undefined && (e.props === null || typeof e.props !== "object" || Array.isArray(e.props))) return `${n.id}: edge ${e.type} props is not an object`
  }
  return undefined
}

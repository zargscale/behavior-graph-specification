/** One canonical JSON file per node at `<dir>/nodes/<id>.json` (§14), and the validating write boundary (§6.2). */
import { existsSync, mkdirSync, readdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs"
import { basename, join } from "node:path"
import { applyChanges, canonical, type Change, changedId, danglingEdges, diff, type Diff, envelopeProblem, make, type Node, type Snapshot } from "./graph.ts"
import { revision } from "./hash.ts"
import { applyDraft, type Draft } from "./draft.ts"
import { check, errors, type Finding } from "./validate.ts"

export type GraphErrorCode = "invalid-node" | "reserved" | "stale-node" | "missing-target" | "rejected"

/** A refused write. The accepted graph is unchanged. */
export class GraphError extends Error {
  constructor(
    readonly code: GraphErrorCode,
    message: string,
    readonly about: ReadonlyArray<string> = [],
    readonly problems: ReadonlyArray<string> = [],
  ) {
    super(message)
  }
}

export interface Problem {
  readonly file: string
  readonly message: string
}

/** A load never fails on one bad file: it skips it, reports it, and reserves its id. */
export interface Loaded {
  readonly snapshot: Snapshot
  readonly problems: ReadonlyArray<Problem>
}

const nodesDir = (dir: string) => join(dir, "nodes")

export const load = (dir: string): Loaded => {
  const nd = nodesDir(dir)
  if (!existsSync(nd)) return { snapshot: make([]), problems: [] }
  const nodes: Array<Node> = []
  const problems: Array<Problem> = []
  for (const name of readdirSync(nd).filter((n) => n.endsWith(".json")).sort()) {
    const file = join(nd, name)
    let parsed: unknown
    try {
      parsed = JSON.parse(readFileSync(file, "utf8"))
    } catch (e) {
      problems.push({ file, message: `not JSON: ${(e as Error).message}` })
      continue
    }
    const bad = envelopeProblem(parsed)
    if (bad !== undefined) problems.push({ file, message: bad })
    else if (`${(parsed as Node).id}.json` !== name) problems.push({ file, message: `id "${(parsed as Node).id}" does not match the file name` })
    else nodes.push(parsed as Node)
  }
  return { snapshot: make(nodes, new Set(problems.map((p) => basename(p.file, ".json")))), problems }
}

/** Node id to the revision the caller last read; `"absent"` expects no node. */
export type Expect = Readonly<Record<string, string>>

export interface Commit {
  readonly before: Snapshot
  readonly after: Snapshot
  readonly diff: Diff
}

/**
 * Storage checks, then writes: envelopes, reserved ids, expected revisions, and targets of the edges this change touches.
 * Each file is replaced atomically (tmp + rename); the whole change is not a transaction. Content rules are `write`'s.
 */
export const commit = (dir: string, changes: ReadonlyArray<Change>, expect: Expect = {}): Commit => {
  for (const c of changes) {
    const bad = c.op === "put" ? envelopeProblem(c.node) : undefined
    if (bad !== undefined) throw new GraphError("invalid-node", bad, [changedId(c)])
  }
  const before = load(dir).snapshot
  for (const c of changes) {
    const id = changedId(c)
    if (before.reserved.has(id)) throw new GraphError("reserved", `${id} failed to load; restore or fix its file first`, [id])
  }
  for (const [id, expected] of Object.entries(expect)) {
    const cur = before.nodes.get(id)
    const actual = cur === undefined ? "absent" : revision(cur)
    if (actual !== expected) throw new GraphError("stale-node", `${id} is at ${actual}, not ${expected}; reread it and reconcile`, [id])
  }
  const after = applyChanges(before, changes)
  // Only edges this change introduces: a damaged file elsewhere must not block unrelated writes.
  const touched = new Set(changes.map(changedId))
  const dangling = danglingEdges(after).find((d) => touched.has(d.from) || touched.has(d.edge.to))
  if (dangling !== undefined) throw new GraphError("missing-target", `${dangling.from} points at ${dangling.edge.to} (${dangling.edge.type}), which is not in the graph`, [dangling.from, dangling.edge.to])
  const d = diff(before, after)
  const nd = nodesDir(dir)
  mkdirSync(nd, { recursive: true })
  for (const node of [...d.added, ...d.changed.map((c) => c.after)]) {
    const file = join(nd, `${node.id}.json`)
    writeFileSync(`${file}.tmp`, canonical(node))
    renameSync(`${file}.tmp`, file)
  }
  for (const node of d.removed) rmSync(join(nd, `${node.id}.json`))
  return { before, after, diff: d }
}

export interface Written extends Commit {
  readonly messages: ReadonlyArray<string>
  readonly warnings: ReadonlyArray<Finding>
}

/** The validating write boundary: a draft applied, checked like a dry run, and committed only when nothing fails. */
export const write = (dir: string, draft: Draft, expect: Expect = {}): Written => {
  const { snapshot } = load(dir)
  const a = applyDraft(snapshot, draft)
  const findings = check(snapshot, a.snapshot)
  const problems = [...a.problems, ...errors(findings).map((f) => f.message)]
  if (problems.length > 0) throw new GraphError("rejected", `rejected: ${problems.join("; ")}`, [], problems)
  // Every node the draft read and changed must still be as it was read.
  const read = Object.fromEntries(a.changes.map(changedId).map((id) => { const n = snapshot.nodes.get(id); return [id, n === undefined ? "absent" : revision(n)] }))
  const c = commit(dir, a.changes, { ...read, ...expect })
  return { ...c, messages: a.messages, warnings: findings.filter((f) => f.severity === "warn") }
}

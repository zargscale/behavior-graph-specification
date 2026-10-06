/** Findings (§5.3): structure from the edge table, props from the kind schemas, and the content lints. */
import { diff, empty, inbound, type Diff, type Node, type Snapshot } from "./graph.ts"
import {
  EDGES, HAS, INTENT, isStatement, JOURNEY, journeys, nameOf, normalize, NS, PERSONA, personas, propsProblems, SCENARIO, similarity, STATE, states, text,
} from "./model.ts"

export interface Finding {
  readonly severity: "error" | "warn"
  readonly code: string
  readonly message: string
  readonly about: ReadonlyArray<string>
}

export interface Context {
  readonly before: Snapshot
  readonly after: Snapshot
  readonly diff: Diff
}

const error = (code: string, message: string, about: ReadonlyArray<string>): Finding => ({ severity: "error", code, message, about })
const warn = (code: string, message: string, about: ReadonlyArray<string>): Finding => ({ severity: "warn", code, message, about })
const full = (local: string) => `${NS}/${local}`
const targets = (to: string | ReadonlyArray<string>) => (typeof to === "string" ? [to] : to).map(full)
const wordCount = (s: string) => s.trim().split(/\s+/).filter((w) => w !== "").length

/** "S-0004 has 0 then edges; it needs 1-5", or undefined when the count fits. */
export const cardinalityProblem = (n: Node): ReadonlyArray<{ readonly code: string; readonly message: string }> =>
  Object.entries(EDGES)
    .filter(([, spec]) => full(spec.from) === n.type)
    .flatMap(([local, spec]) => {
      const count = n.edges.filter((e) => e.type === full(local)).length
      const low = spec.min !== undefined && count < spec.min
      const high = spec.max !== undefined && count > spec.max
      if (!low && !high) return []
      const range = `${spec.min ?? 0}${spec.max !== undefined ? `-${spec.max}` : " or more"}`
      return [{ code: low ? "too-few-edges" : "too-many-edges", message: `${n.id} has ${count} ${local} edge${count === 1 ? "" : "s"}; it needs ${range}` }]
    })

/** Types, edges, endpoints, duplicates and cardinality of one node. Gherkin types only; other namespaces are opaque. */
export const structure = (snap: Snapshot, n: Node): ReadonlyArray<Finding> => {
  const [ns, kind] = n.type.split("/")
  if (ns !== NS) return []
  if (kind === undefined || !(kind in KIND_SET)) return [error("unknown-type", `${n.id}: unknown node type "${n.type}"`, [n.id])]
  const found: Array<Finding> = []
  const seen = new Set<string>()
  for (const e of n.edges) {
    const local = e.type.startsWith(`${NS}/`) ? e.type.slice(NS.length + 1) : undefined
    const spec = local === undefined ? undefined : EDGES[local]
    if (spec === undefined) {
      if (e.type.startsWith(`${NS}/`)) found.push(error("unknown-edge", `${n.id}: unknown edge type "${e.type}"`, [n.id]))
      continue
    }
    if (full(spec.from) !== n.type) found.push(error("edge-source", `${n.id}: "${e.type}" edges must start at a ${full(spec.from)}`, [n.id]))
    const target = snap.nodes.get(e.to)
    if (target === undefined) found.push(error("missing-target", `${n.id} points at ${e.to}, which is not in the graph`, [n.id, e.to]))
    else if (!targets(spec.to).includes(target.type)) found.push(error("edge-target", `${n.id}: "${e.type}" must point to a ${targets(spec.to).join(" or ")}, ${e.to} is a ${target.type}`, [n.id, e.to]))
    const key = `${e.type}\u0000${e.to}`
    if (seen.has(key)) found.push(error("duplicate-edge", `${n.id}: links ${e.to} as "${e.type}" twice; remove the duplicate`, [n.id, e.to]))
    seen.add(key)
  }
  for (const c of cardinalityProblem(n)) found.push(error(c.code, c.message, [n.id]))
  const props = propsProblems(n)
  if (props.length > 0) found.push(error("invalid-props", `${n.id}: props do not match ${n.type}: ${props.join("; ")}`, [n.id]))
  return found
}
const KIND_SET = { state: 1, scenario: 1, persona: 1, journey: 1, intent: 1, outcome: 1, constraint: 1, question: 1 }

const touched = (ctx: Context): ReadonlyArray<Node> => [...ctx.diff.added, ...ctx.diff.changed.map((c) => c.after)]

const MAX_WORDS = 15
const MAX_STATEMENT_WORDS = 20

/** One atomic fact per clause (§5.1, §9.3). */
const clauseShape = (ctx: Context): ReadonlyArray<Finding> =>
  touched(ctx).flatMap((n) => {
    const clause = n.type === STATE || isStatement(n) ? text(n) : n.type === SCENARIO ? String(n.props.when ?? "") : undefined
    if (clause === undefined) return []
    const found: Array<Finding> = []
    const max = isStatement(n) ? MAX_STATEMENT_WORDS : MAX_WORDS
    const count = wordCount(clause)
    if (count > max) found.push(error("clause-too-long", `${n.id}: "${clause}" has ${count} words; keep it to ${max} or fewer`, [n.id]))
    if (/\bif\b/i.test(clause)) found.push(error("conditional", `${n.id}: "${clause}" contains "if"; make one scenario per case instead`, [n.id]))
    if (n.type === SCENARIO && /\bor\b/i.test(clause)) found.push(warn("alternatives", `${n.id}: "${clause}" contains "or"; make one scenario per case when the cases lead to different outcomes`, [n.id]))
    if (/\band\b/i.test(clause)) found.push(warn("and-chaining", `${n.id}: "${clause}" contains "and"; split it if it states two facts`, [n.id]))
    return found
  })

/** Unique state text; near-identical text is probably the same state (§5.2). */
const stateText = (ctx: Context): ReadonlyArray<Finding> =>
  touched(ctx)
    .filter((n) => n.type === STATE)
    .flatMap((n) =>
      states(ctx.after)
        .filter((o) => o.id !== n.id)
        .flatMap((o): ReadonlyArray<Finding> => {
          if (normalize(text(o)) === normalize(text(n))) return [error("duplicate-state", `${n.id} repeats the text of ${o.id}; reuse ${o.id}`, [n.id, o.id])]
          if (similarity(text(o), text(n)) >= 0.8) return [warn("near-duplicate-state", `${n.id} "${text(n)}" is close to ${o.id} "${text(o)}"; merge them if they mean the same`, [n.id, o.id])]
          return []
        }),
    )

const personaShape = (ctx: Context): ReadonlyArray<Finding> =>
  touched(ctx)
    .filter((n) => n.type === PERSONA)
    .flatMap((n) => {
      const found: Array<Finding> = []
      const name = nameOf(n)
      if (wordCount(name) > 4) found.push(error("persona-name-long", `${n.id}: "${name}" has ${wordCount(name)} words; a persona name has at most 4 words`, [n.id]))
      const t = text(n)
      if (wordCount(t) > 60) found.push(error("persona-text-long", `${n.id}: its text has ${wordCount(t)} words; keep it to at most 60 words`, [n.id]))
      for (const o of personas(ctx.after))
        if (o.id !== n.id && normalize(nameOf(o)) === normalize(name)) found.push(error("duplicate-persona", `${n.id} has the name of ${o.id} ("${nameOf(o)}"); use ${o.id}`, [n.id, o.id]))
      return found
    })

const journeyShape = (ctx: Context): ReadonlyArray<Finding> =>
  touched(ctx)
    .filter((n) => n.type === JOURNEY)
    .flatMap((n) =>
      journeys(ctx.after)
        .filter((o) => o.id !== n.id && normalize(nameOf(o)) === normalize(nameOf(n)))
        .map((o) => error("duplicate-journey", `${n.id} has the name of ${o.id} ("${nameOf(o)}"); use ${o.id}`, [n.id, o.id])),
    )

const intentShape = (ctx: Context): ReadonlyArray<Finding> =>
  touched(ctx)
    .filter((n) => n.type === INTENT)
    .flatMap((n) => {
      const count = wordCount(String(n.props.title ?? ""))
      return count > 10 ? [error("intent-title-long", `${n.id}: its title has ${count} words; keep it to 10 or fewer`, [n.id])] : []
    })

/** Every statement belongs to exactly one intent: touched statements, and those a touched intent claims or let go (§9.3). */
const statementOwner = (ctx: Context): ReadonlyArray<Finding> => {
  const t = touched(ctx)
  const hasTargets = (s: Snapshot, id: string) => (s.nodes.get(id)?.edges ?? []).filter((e) => e.type === HAS).map((e) => e.to)
  const ids = new Set([...t.filter(isStatement).map((n) => n.id), ...t.filter((n) => n.type === INTENT).flatMap((n) => [...hasTargets(ctx.before, n.id), ...hasTargets(ctx.after, n.id)])])
  return [...ids].flatMap((id) => {
    const n = ctx.after.nodes.get(id)
    if (n === undefined || !isStatement(n)) return []
    const owners = inbound(ctx.after, id, HAS).map((e) => e.from).sort()
    if (owners.length === 1) return []
    return [error("statement-owner", owners.length === 0 ? `${id} belongs to no intent` : `${id} belongs to ${owners.join(", ")}; a statement belongs to exactly one intent`, [id, ...owners])]
  })
}

export const LINTS: ReadonlyArray<(ctx: Context) => ReadonlyArray<Finding>> = [clauseShape, stateText, personaShape, journeyShape, intentShape, statementOwner]

/** Every finding about what changed between two snapshots: structure of touched nodes, then lints. */
export const check = (before: Snapshot, after: Snapshot): ReadonlyArray<Finding> => {
  const ctx = { before, after, diff: diff(before, after) }
  return [...touched(ctx).flatMap((n) => structure(after, n)), ...LINTS.flatMap((l) => l(ctx))]
}

/** Every finding about a whole graph. */
export const checkAll = (snap: Snapshot): ReadonlyArray<Finding> => check(empty, snap)

export const errors = (fs: ReadonlyArray<Finding>) => fs.filter((f) => f.severity === "error")

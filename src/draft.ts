/** Drafts (§6.4): ordered operations over an in-memory snapshot, previews, and change impact (§11.2). */
import { applyChanges, type Change, changedId, diff, inbound, nextId, type Snapshot } from "./graph.ts"
import { FROM, IN, SCENARIO, STATE } from "./model.ts"
import { OpError, runOp } from "./ops.ts"
import { cardinalityProblem, check, errors, type Finding } from "./validate.ts"

export type Draft = ReadonlyArray<{ readonly tool: string; readonly params?: unknown }>

export interface Applied {
  readonly snapshot: Snapshot
  readonly changes: ReadonlyArray<Change>
  readonly messages: ReadonlyArray<string>
  /** Operations that failed, prefixed with their tool name. Their changes were not applied. */
  readonly problems: ReadonlyArray<string>
}

/** Each operation sees what earlier ones made; each must leave edge counts and targets valid (a later one cannot repair it). */
export const applyDraft = (snap: Snapshot, draft: Draft): Applied => {
  let now = snap
  const changes: Array<Change> = []
  const messages: Array<string> = []
  const problems: Array<string> = []
  for (const call of draft) {
    let result
    try {
      result = runOp(call.tool, call.params, now)
    } catch (e) {
      if (!(e instanceof OpError)) throw e
      problems.push(`${call.tool}: ${e.message}`)
      continue
    }
    const next = applyChanges(now, result.changes)
    const broken = result.changes.flatMap((c) => {
      const n = next.nodes.get(changedId(c))
      return n === undefined ? [] : [...cardinalityProblem(n).map((x) => x.message), ...n.edges.filter((e) => !next.nodes.has(e.to)).map((e) => `${n.id} points at ${e.to}, which is not in the graph`)]
    })
    if (broken.length > 0) {
      problems.push(...broken.map((b) => `${call.tool}: ${b}`))
      continue
    }
    now = next
    changes.push(...result.changes)
    messages.push(result.message)
  }
  return { snapshot: now, changes, messages, problems }
}

export interface Affected {
  /** Added scenarios, changed behavior, or using a reworded state. Sorted. */
  readonly scenarios: ReadonlyArray<string>
  /** Scenarios that no longer exist. Sorted. */
  readonly removed: ReadonlyArray<string>
}

export const affected = (before: Snapshot, after: Snapshot): Affected => {
  const d = diff(before, after)
  const ids = new Set<string>()
  for (const n of d.added) if (n.type === SCENARIO) ids.add(n.id)
  // What code depends on: words and edges, not planned, journey membership, nor provenance.
  const behavior = (n: { readonly props: Readonly<Record<string, unknown>>; readonly edges: ReadonlyArray<{ readonly type: string; readonly to: string }> }) => {
    const { planned: _, ...props } = n.props
    return JSON.stringify([props, n.edges.filter((e) => e.type !== IN && e.type !== FROM)])
  }
  for (const c of d.changed) {
    if (c.after.type === SCENARIO && behavior(c.before) !== behavior(c.after)) ids.add(c.id)
    else if (c.after.type === STATE && c.before.props.text !== c.after.props.text)
      for (const e of inbound(after, c.id)) if (after.nodes.get(e.from)?.type === SCENARIO) ids.add(e.from)
  }
  return { scenarios: [...ids].sort(), removed: d.removed.filter((n) => n.type === SCENARIO).map((n) => n.id).sort() }
}

export interface DryRun {
  readonly ok: boolean
  readonly problems: ReadonlyArray<string>
  readonly touched: ReadonlyArray<string>
  readonly scenarios: ReadonlyArray<string>
  readonly messages: ReadonlyArray<string>
  /** The ids the next additions would get. Informational: reserves nothing. */
  readonly next: { readonly scenario: string; readonly state: string; readonly journey: string; readonly persona: string }
  readonly warnings: ReadonlyArray<Finding>
}

/** A draft checked as a write would be, without writing. */
export const dryRun = (snap: Snapshot, draft: Draft): DryRun => {
  const a = applyDraft(snap, draft)
  const findings = check(snap, a.snapshot)
  const problems = [...a.problems, ...errors(findings).map((f) => f.message)]
  const d = diff(snap, a.snapshot)
  const id = (prefix: string) => nextId(a.snapshot, prefix)
  return {
    ok: problems.length === 0,
    problems,
    touched: [...d.added, ...d.changed, ...d.removed].map((n) => n.id).sort(),
    scenarios: affected(snap, a.snapshot).scenarios,
    messages: a.messages,
    next: { scenario: id("S"), state: id("ST"), journey: id("J"), persona: id("P") },
    warnings: findings.filter((f) => f.severity === "warn"),
  }
}

/** Entity references and envelopes (§13), and scenario versions (§10.1). */
import type { Node, Snapshot } from "./graph.ts"
import { versionOf } from "./hash.ts"
import { labelOf, SCENARIO } from "./model.ts"

export interface Ref {
  readonly type: string
  readonly id: string
  readonly version?: string
}

const TYPE = /^[a-z][a-z0-9-]*\/[a-z][a-z0-9-]*$/
const ID = /^[A-Za-z0-9._-]+$/

/** Why `s` is not a ref, or undefined. */
export const refProblem = (s: string): string | undefined => {
  const colon = s.indexOf(":")
  if (colon < 0) return `"${s}" has no type: a ref is <namespace>/<kind>:<id>`
  const type = s.slice(0, colon)
  if (!TYPE.test(type)) return `"${type}" is not a type: a type is namespace/kind, like gherkin/scenario`
  const rest = s.slice(colon + 1)
  if (rest.includes(":")) return `"${s}" has more than one ":"`
  const [id, version, extra] = rest.split("@")
  if (id === undefined || id.length === 0) return `"${s}" has no id`
  if (!ID.test(id)) return `"${id}" is not a valid id`
  if (extra !== undefined) return `"${s}" has more than one "@"`
  if (version !== undefined && !/^[0-9a-f]+$/.test(version)) return `"${s}" has an empty or non-hex version`
  return undefined
}

export const parseRef = (s: string): Ref | undefined => {
  if (refProblem(s) !== undefined) return undefined
  const colon = s.indexOf(":")
  const [id, version] = s.slice(colon + 1).split("@")
  return { type: s.slice(0, colon), id: id!, ...(version !== undefined ? { version } : {}) }
}

export const formatRef = (r: Ref): string => `${r.type}:${r.id}${r.version !== undefined ? `@${r.version}` : ""}`

/** What a tester reads: props except planned, then every non-journey edge with its target's wording. */
export const scenarioVersionInput = (snap: Snapshot, id: string) => {
  const scenario = snap.nodes.get(id)
  if (scenario === undefined || scenario.type !== SCENARIO) return undefined
  // A persona contributes its name, not its description (§10.2).
  const wording = (to: string) => { const n = snap.nodes.get(to); return n === undefined ? to : labelOf(n) }
  const { planned: _, ...props } = scenario.props
  return { props, steps: scenario.edges.filter((e) => e.type !== "gherkin/in").map((e) => ({ edge: e.type, to: e.to, text: wording(e.to) })) }
}

export const scenarioVersion = (snap: Snapshot, id: string): string | undefined => {
  const input = scenarioVersionInput(snap, id)
  return input === undefined ? undefined : versionOf(input)
}

/** A node's entity version: the scenario version for scenarios, else a fingerprint of {props, edges}. */
export const entityVersion = (snap: Snapshot, n: Node): string =>
  n.type === SCENARIO ? scenarioVersion(snap, n.id)! : versionOf({ props: n.props, edges: n.edges })

const GLYPHS: Readonly<Record<string, readonly [string, string]>> = {
  "gherkin/scenario": ["scenario", "◇"],
  "gherkin/state": ["state", "○"],
  "gherkin/persona": ["persona", "◎"],
  "gherkin/journey": ["journey", "↝"],
  "gherkin/intent": ["accent", "◈"],
  "gherkin/outcome": ["ok", "▸"],
  "gherkin/constraint": ["attention", "▪"],
  "gherkin/question": ["dim", "?"],
}

export interface Entity {
  readonly ref: string
  readonly type: string
  readonly id: string
  readonly version: string
  readonly label: { readonly text: string; readonly tone: string; readonly glyph: string }
  readonly data: { readonly props: Node["props"]; readonly edges: Node["edges"] }
}

export type EntityFailure = "NotFound" | "UnknownType" | "NotAllowed" | "ProviderFailed" | "OutOfScope"
export type Resolved = { readonly entity: Entity } | { readonly failure: EntityFailure; readonly message: string }

export const toEntity = (snap: Snapshot, n: Node): Entity => {
  const version = entityVersion(snap, n)
  const [tone, glyph] = GLYPHS[n.type] ?? ["dim", "·"]
  return {
    ref: formatRef({ type: n.type, id: n.id, version }),
    type: n.type,
    id: n.id,
    version,
    label: { text: n.type === SCENARIO ? `${n.id} ${String(n.props.title ?? "")}`.trim() : labelOf(n), tone, glyph },
    data: { props: n.props, edges: n.edges },
  }
}

/** Resolves a ref to its current entity. A versioned ref resolves too: compare `entity.version` to see if it is stale. */
export const resolve = (snap: Snapshot, s: string): Resolved => {
  const ref = parseRef(s)
  if (ref === undefined) return { failure: "NotFound", message: refProblem(s) ?? `bad ref ${s}` }
  if (!(ref.type in GLYPHS)) return { failure: "UnknownType", message: `no provider for ${ref.type}` }
  const n = snap.nodes.get(ref.id)
  if (n === undefined || n.type !== ref.type) return { failure: "NotFound", message: `${ref.type}:${ref.id} does not exist` }
  return { entity: toEntity(snap, n) }
}

/** Entities of a type whose props contain every `where` pair and whose label contains `text`. */
export const query = (snap: Snapshot, q: { readonly type: string; readonly where?: Readonly<Record<string, unknown>>; readonly text?: string; readonly limit?: number }): ReadonlyArray<Entity> =>
  [...snap.nodes.values()]
    .filter((n) => n.type === q.type)
    .sort((a, b) => a.id.localeCompare(b.id))
    .filter((n) => Object.entries(q.where ?? {}).every(([k, v]) => JSON.stringify(n.props[k]) === JSON.stringify(v)))
    .map((n) => toEntity(snap, n))
    .filter((e) => q.text === undefined || e.label.text.toLowerCase().includes(q.text.toLowerCase()))
    .slice(0, q.limit ?? Infinity)

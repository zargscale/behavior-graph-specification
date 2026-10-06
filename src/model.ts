/** The gherkin namespace: node kinds (§3.2, §9.1), the edge table (§3.3, §9.2), and their property rules. */
import { byType, inbound, out, type Node, type Snapshot } from "./graph.ts"

export const NS = "gherkin"
export const STATE = "gherkin/state"
export const SCENARIO = "gherkin/scenario"
export const PERSONA = "gherkin/persona"
export const JOURNEY = "gherkin/journey"
export const INTENT = "gherkin/intent"
export const OUTCOME = "gherkin/outcome"
export const CONSTRAINT = "gherkin/constraint"
export const QUESTION = "gherkin/question"

export const ARRIVES = "gherkin/arrives"
export const GIVEN = "gherkin/given"
export const THEN = "gherkin/then"
export const BY = "gherkin/by"
export const IN = "gherkin/in"
export const HAS = "gherkin/has"
export const FOR = "gherkin/for"
export const SERVES = "gherkin/serves"
export const BOUNDS = "gherkin/bounds"

export interface EdgeSpec {
  readonly from: string
  readonly to: string | ReadonlyArray<string>
  readonly min?: number
  readonly max?: number
}

/** The declarative edge table: local edge names and local node kinds. */
export const EDGES: Readonly<Record<string, EdgeSpec>> = {
  arrives: { from: "scenario", to: "state", min: 1, max: 1 },
  given: { from: "scenario", to: "state", max: 3 },
  then: { from: "scenario", to: "state", min: 1, max: 5 },
  by: { from: "scenario", to: "persona" },
  in: { from: "scenario", to: "journey" },
  has: { from: "intent", to: ["outcome", "constraint", "question"] },
  for: { from: "intent", to: "persona" },
  serves: { from: "journey", to: "outcome" },
  bounds: { from: "constraint", to: ["journey", "scenario"] },
}

type Field = { readonly kind: "string" | "boolean"; readonly optional?: boolean; readonly values?: ReadonlyArray<string>; readonly empty?: boolean }
const str: Field = { kind: "string" }
const optStr: Field = { kind: "string", optional: true }
const optBool: Field = { kind: "boolean", optional: true }

/** Property schemas per local kind. Unknown properties are allowed and kept. */
export const KINDS: Readonly<Record<string, Readonly<Record<string, Field>>>> = {
  state: { text: str, entry: optBool, terminal: optBool },
  scenario: { title: str, when: str, planned: optBool },
  persona: { name: str, kind: { kind: "string", values: ["human", "cli", "agent"] }, text: str },
  journey: { name: str },
  intent: { title: str, problem: { kind: "string", optional: true, empty: true }, status: { kind: "string", values: ["draft", "accepted"] } },
  outcome: { text: str },
  constraint: { text: str },
  question: { text: str, answer: optStr },
}

/** Why a node's props break its kind's schema; empty when they fit or the kind is not gherkin's. */
export const propsProblems = (n: Node): ReadonlyArray<string> => {
  const [ns, kind] = n.type.split("/")
  const schema = ns === NS && kind !== undefined ? KINDS[kind] : undefined
  if (schema === undefined) return []
  return Object.entries(schema).flatMap(([key, f]): ReadonlyArray<string> => {
    const v = n.props[key]
    if (v === undefined) return f.optional === true ? [] : [`${key} is required`]
    if (typeof v !== f.kind) return [`${key} must be a ${f.kind}`]
    if (f.kind === "string" && f.empty !== true && (v as string).trim() === "") return [`${key} must not be empty`]
    if (f.values !== undefined && !f.values.includes(v as string)) return [`${key} must be one of ${f.values.join(", ")}`]
    return []
  })
}

/** Lowercase, trim, collapse whitespace, drop one trailing period (§5.2). */
export const normalize = (s: string): string => s.toLowerCase().trim().replace(/\s+/g, " ").replace(/\.$/, "")

const words = (s: string) => new Set(normalize(s).split(" "))
/** Jaccard similarity of normalized word sets, in [0, 1]. */
export const similarity = (a: string, b: string): number => {
  const x = words(a)
  const y = words(b)
  const both = [...x].filter((w) => y.has(w)).length
  return both / (x.size + y.size - both)
}

export const text = (n: Node): string => String(n.props.text ?? "")
export const nameOf = (n: Node): string => String(n.props.name ?? "")
/** A node's human label: text, name or title. */
export const labelOf = (n: Node): string => String(n.props.name ?? n.props.title ?? n.props.text ?? n.id)

export const states = (snap: Snapshot) => byType(snap, STATE)
export const scenarios = (snap: Snapshot) => byType(snap, SCENARIO)
export const personas = (snap: Snapshot) => byType(snap, PERSONA)
export const journeys = (snap: Snapshot) => byType(snap, JOURNEY)
export const intents = (snap: Snapshot) => byType(snap, INTENT)

export const STATEMENTS: ReadonlyArray<string> = [OUTCOME, CONSTRAINT, QUESTION]
export const isStatement = (n: Node): boolean => STATEMENTS.includes(n.type)

export const findStateByText = (snap: Snapshot, t: string): Node | undefined => states(snap).find((s) => normalize(text(s)) === normalize(t))

export type NamedRef = { readonly id: string } | { readonly name: string }
const findNamed = (snap: Snapshot, type: string, ref: NamedRef): Node | undefined => {
  if ("id" in ref) {
    const n = snap.nodes.get(ref.id)
    return n?.type === type ? n : undefined
  }
  return byType(snap, type).find((p) => normalize(nameOf(p)) === normalize(ref.name))
}
export const findPersona = (snap: Snapshot, ref: NamedRef) => findNamed(snap, PERSONA, ref)
export const findJourney = (snap: Snapshot, ref: NamedRef) => findNamed(snap, JOURNEY, ref)

export const statementsOf = (snap: Snapshot, intent: string): ReadonlyArray<Node> =>
  out(snap, intent, HAS).flatMap((e) => {
    const n = snap.nodes.get(e.to)
    return n === undefined ? [] : [n]
  })
export const intentOf = (snap: Snapshot, statement: string): string | undefined => inbound(snap, statement, HAS)[0]?.from

/** Scenarios that start where `scenario`'s outcome states lead: the derived flow (§4). */
export const nextOf = (snap: Snapshot, scenario: string): ReadonlyArray<string> =>
  [...new Set(out(snap, scenario, THEN).flatMap((e) => inbound(snap, e.to, ARRIVES).map((x) => x.from)))].sort()

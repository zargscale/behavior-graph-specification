/** The operation vocabulary (§6.2, §9.3): each turns params and a snapshot into changes, or throws an OpError. */
import { applyChanges, type Change, inbound, nextId, type Node, Put, Remove, type Snapshot } from "./graph.ts"
import {
  ARRIVES, BOUNDS, BY, CONSTRAINT, findJourney, findPersona, findStateByText, FOR, GIVEN, HAS, IN, INTENT, isStatement, JOURNEY, journeys, nameOf, type NamedRef,
  OUTCOME, PERSONA, personas, QUESTION, SCENARIO, SERVES, STATE, THEN,
} from "./model.ts"

export class OpError extends Error {}

export interface OpResult {
  readonly changes: ReadonlyArray<Change>
  /** One line: what happened, with the ids it created. */
  readonly message: string
}

export interface Op {
  readonly name: string
  readonly description: string
  readonly run: (params: Params, snap: Snapshot) => OpResult
}

type Params = Readonly<Record<string, unknown>>

const fail = (message: string): never => {
  throw new OpError(message)
}
const isObj = (v: unknown): v is Params => v !== null && typeof v === "object" && !Array.isArray(v)
const reqStr = (p: Params, key: string): string => {
  const v = p[key]
  return typeof v === "string" && v.trim() !== "" ? v : fail(`${key} must be a nonempty string`)
}
const optStr = (p: Params, key: string): string | undefined => (p[key] === undefined ? undefined : reqStr(p, key))
const optBool = (p: Params, key: string): boolean | undefined => {
  const v = p[key]
  return v === undefined ? undefined : typeof v === "boolean" ? v : fail(`${key} must be true or false`)
}
const oneOf = <T extends string>(p: Params, key: string, values: ReadonlyArray<T>): T | undefined => {
  const v = p[key]
  return v === undefined ? undefined : values.includes(v as T) ? (v as T) : fail(`${key} must be one of ${values.join(", ")}`)
}
const list = (p: Params, key: string): ReadonlyArray<unknown> => {
  const v = p[key]
  return v === undefined ? [] : Array.isArray(v) ? v : fail(`${key} must be a list`)
}
/** Only the keys given: an edit patch. */
const pick = (p: Params, keys: ReadonlyArray<string>) => Object.fromEntries(keys.filter((k) => p[k] !== undefined).map((k) => [k, p[k]])) as Record<string, never>

/** Why `id` is not a `type`, with the ids of that type there, so a guessed id can be fixed. */
const notA = (snap: Snapshot, id: string, type: string) => {
  const n = snap.nodes.get(id)
  if (n !== undefined) return `${id} is a ${n.type}, not a ${type}`
  const there = [...snap.nodes.values()].filter((x) => x.type === type).map((x) => x.id)
  return `${id} does not exist; the ${type.split("/").pop()}s there: ${there.length > 0 ? there.slice(0, 12).join(", ") : "none"}`
}
const getNode = (snap: Snapshot, id: unknown, type: string): Node => {
  if (typeof id !== "string") return fail(`expected a ${type} id`)
  const n = snap.nodes.get(id)
  return n?.type === type ? n : fail(notA(snap, id, type))
}

/** A persona or journey by {id}, {name}, or a plain string (an id when it looks like one, else a name). */
const namedRef = (raw: unknown, prefix: string): NamedRef => {
  if (typeof raw === "string") return new RegExp(`^${prefix}-\\d+$`).test(raw) ? { id: raw } : { name: raw }
  if (isObj(raw) && typeof raw.id === "string") return { id: raw.id }
  if (isObj(raw) && typeof raw.name === "string") return { name: raw.name }
  return fail(`expected {id} or {name}, got ${JSON.stringify(raw)}`)
}
const describe = (ref: NamedRef) => ("id" in ref ? ref.id : `"${ref.name}"`)
const personaOf = (snap: Snapshot, raw: unknown): string => {
  const ref = namedRef(raw, "P")
  return findPersona(snap, ref)?.id ?? fail(`${describe(ref)} is not a persona; known: ${personas(snap).map((p) => `${p.id} ${nameOf(p)}`).join(", ") || "none yet (add one with add-persona)"}`)
}
const journeyOf = (snap: Snapshot, raw: unknown): string => {
  const ref = namedRef(raw, "J")
  return findJourney(snap, ref)?.id ?? fail(`${describe(ref)} is not a journey; known: ${journeys(snap).map((j) => `${j.id} ${nameOf(j)}`).join(", ") || "none yet (add one with add-journey)"}`)
}

/** Resolves state refs against a working snapshot, creating states for new text (reusable within the same operation). */
const resolver = (snap: Snapshot) => {
  let working = snap
  const created: Array<Node> = []
  const resolve = (ref: unknown): string => {
    if (isObj(ref) && typeof ref.id === "string") return working.nodes.get(ref.id)?.type === STATE ? ref.id : fail(notA(working, ref.id, STATE))
    if (!isObj(ref) || typeof ref.text !== "string" || ref.text.trim() === "") return fail(`a state is {id} or {text}, got ${JSON.stringify(ref)}`)
    const existing = findStateByText(working, ref.text)
    if (existing !== undefined) return existing.id
    const node: Node = { id: nextId(working, "ST"), type: STATE, props: { text: ref.text }, edges: [] }
    created.push(node)
    working = applyChanges(working, [Put(node)])
    return node.id
  }
  return { resolve, created, next: (prefix: string) => nextId(working, prefix) }
}
const createdNote = (created: ReadonlyArray<Node>) => (created.length === 0 ? "" : `; new states ${created.map((s) => s.id).join(", ")}`)
const updated = (n: Node, props: Record<string, unknown>): OpResult => ({ changes: [Put({ ...n, props: { ...n.props, ...props } as Node["props"] })], message: `updated ${n.id}` })

const KINDS = ["human", "cli", "agent"] as const

const addState: Op = {
  name: "add-state",
  description: "Add a state (a Given/Then sentence). Fails when a state has the same normalized text.",
  run: (p, snap) => {
    const t = reqStr(p, "text")
    const existing = findStateByText(snap, t)
    if (existing !== undefined) fail(`${existing.id} already has this text; use it`)
    const id = nextId(snap, "ST")
    return { changes: [Put({ id, type: STATE, props: { text: t, ...pick(p, ["entry", "terminal"]) }, edges: [] })], message: `created ${id}` }
  },
}

const editState: Op = {
  name: "edit-state",
  description: "Reword a state or change its entry/terminal flags. Every scenario using it renders the change.",
  run: (p, snap) => {
    optStr(p, "text"), optBool(p, "entry"), optBool(p, "terminal")
    return updated(getNode(snap, p.id, STATE), pick(p, ["text", "entry", "terminal"]))
  },
}

const addPersona: Op = {
  name: "add-persona",
  description: "Add a persona: {name, kind: human|cli|agent, text}.",
  run: (p, snap) => {
    const name = reqStr(p, "name")
    const kind = oneOf(p, "kind", KINDS) ?? fail("kind must be one of human, cli, agent")
    const t = reqStr(p, "text")
    const existing = findPersona(snap, { name })
    // The same persona again (a draft that did not see it): used as it is.
    if (existing !== undefined && existing.props.kind === kind) return { changes: [], message: `${existing.id} is already ${nameOf(existing)}: no change` }
    if (existing !== undefined) fail(`${existing.id} is already called "${nameOf(existing)}"; use it`)
    const id = nextId(snap, "P")
    return { changes: [Put({ id, type: PERSONA, props: { name, kind, text: t }, edges: [] })], message: `created ${id}` }
  },
}

const editPersona: Op = {
  name: "edit-persona",
  description: "Rename a persona, or change its kind or text.",
  run: (p, snap) => {
    optStr(p, "name"), oneOf(p, "kind", KINDS), optStr(p, "text")
    return updated(getNode(snap, p.id, PERSONA), pick(p, ["name", "kind", "text"]))
  },
}

const addJourney: Op = {
  name: "add-journey",
  description: "Add a journey: a named group of scenarios (link {edge: \"in\"}).",
  run: (p, snap) => {
    const name = reqStr(p, "name")
    const existing = findJourney(snap, { name })
    if (existing !== undefined) fail(`${existing.id} is already called "${nameOf(existing)}"; use it`)
    const id = nextId(snap, "J")
    return { changes: [Put({ id, type: JOURNEY, props: { name }, edges: [] })], message: `created ${id}` }
  },
}

const editJourney: Op = {
  name: "edit-journey",
  description: "Rename a journey.",
  run: (p, snap) => updated(getNode(snap, p.id, JOURNEY), { name: reqStr(p, "name") }),
}

const addScenario: Op = {
  name: "add-scenario",
  description: "Add a scenario: title, when, by (1+ personas), arrives (one state), given (0-3 states), then (1-5 states). States by {id} or {text}.",
  run: (p, snap) => {
    const title = reqStr(p, "title")
    const when = reqStr(p, "when")
    const byRefs = list(p, "by")
    if (byRefs.length === 0) fail(`a scenario needs at least one persona in by; known: ${personas(snap).map((x) => `${x.id} ${nameOf(x)}`).join(", ") || "none yet"}`)
    const by = byRefs.map((r) => personaOf(snap, r))
    const r = resolver(snap)
    const arrives = r.resolve(p.arrives)
    const given = list(p, "given").map(r.resolve)
    const then = list(p, "then").map(r.resolve)
    const id = r.next("S")
    const scenario: Node = {
      id,
      type: SCENARIO,
      props: { title, when },
      edges: [...by.map((to) => ({ type: BY, to })), { type: ARRIVES, to: arrives }, ...given.map((to) => ({ type: GIVEN, to })), ...then.map((to) => ({ type: THEN, to }))],
    }
    return { changes: [...r.created.map(Put), Put(scenario)], message: `created ${id}${createdNote(r.created)}` }
  },
}

const editScenario: Op = {
  name: "edit-scenario",
  description: "Change a scenario's title or when, or mark it planned (true: not built yet; false: clears it).",
  run: (p, snap) => {
    const n = getNode(snap, p.id, SCENARIO)
    optStr(p, "title"), optStr(p, "when")
    const planned = optBool(p, "planned")
    // planned is stored only while true.
    const { planned: was, ...rest } = n.props
    const keep = planned ?? was === true
    return { changes: [Put({ ...n, props: { ...rest, ...pick(p, ["title", "when"]), ...(keep ? { planned: true } : {}) } })], message: `updated ${n.id}` }
  },
}

const EDGE_TYPES = { arrives: ARRIVES, given: GIVEN, then: THEN, by: BY, in: IN, serves: SERVES, bounds: BOUNDS, for: FOR } as const
type EdgeName = keyof typeof EDGE_TYPES
const edgeName = (p: Params): EdgeName => oneOf(p, "edge", Object.keys(EDGE_TYPES) as Array<EdgeName>) ?? fail(`edge must be one of ${Object.keys(EDGE_TYPES).join(", ")}`)

const link: Op = {
  name: "link",
  description:
    'Connect a scenario to a state (arrives replaces the current one; given; then), a persona (by) or a journey (in). Also {edge: "serves", journey, outcome}, {edge: "bounds", constraint, journey | scenario}, {edge: "for", intent, persona}.',
  run: (p, snap) => {
    const edge = edgeName(p)
    const type = EDGE_TYPES[edge]
    const linkFrom = (source: Node, to: string, created: ReadonlyArray<Node> = []): OpResult =>
      source.edges.some((e) => e.type === type && e.to === to)
        ? { changes: [], message: `${source.id} already has ${edge} ${to}: no change` }
        : {
            changes: [...created.map(Put), Put({ ...source, edges: [...(edge === "arrives" ? source.edges.filter((e) => e.type !== ARRIVES) : source.edges), { type, to }] })],
            message: `linked ${source.id} ${edge} ${to}${createdNote(created)}`,
          }
    if (edge === "serves") {
      if (p.journey === undefined || p.outcome === undefined) fail("serves takes {journey: {id} or {name}, outcome: id}")
      const journey = getNode(snap, journeyOf(snap, p.journey), JOURNEY)
      return linkFrom(journey, getNode(snap, p.outcome, OUTCOME).id)
    }
    if (edge === "bounds") {
      if (p.constraint === undefined || (p.journey === undefined) === (p.scenario === undefined)) fail("bounds takes {constraint: id} and one of {journey} or {scenario: id}")
      const to = p.journey !== undefined ? journeyOf(snap, p.journey) : getNode(snap, p.scenario, SCENARIO).id
      return linkFrom(getNode(snap, p.constraint, CONSTRAINT), to)
    }
    if (edge === "for") {
      if (p.intent === undefined || p.persona === undefined) fail("for takes {intent: id, persona: {id} or {name}}")
      return linkFrom(getNode(snap, p.intent, INTENT), personaOf(snap, p.persona))
    }
    if (p.scenario === undefined) fail(`${edge} takes {scenario: id}`)
    const scenario = getNode(snap, p.scenario, SCENARIO)
    if (edge === "by") return p.persona === undefined ? fail("by takes {persona: {id} or {name}}") : linkFrom(scenario, personaOf(snap, p.persona))
    if (edge === "in") return p.journey === undefined ? fail("in takes {journey: {id} or {name}}") : linkFrom(scenario, journeyOf(snap, p.journey))
    if (p.state === undefined) fail(`${edge} takes {state: {id} or {text}}`)
    const r = resolver(snap)
    const to = r.resolve(p.state)
    return linkFrom(scenario, to, r.created)
  },
}

const unlink: Op = {
  name: "unlink",
  description: "Remove a relationship: {edge, scenario, state | persona | journey: id}; or serves {journey, outcome}, bounds {constraint, journey | scenario}, for {intent, persona}. Refuses a scenario's last persona.",
  run: (p, snap) => {
    const edge = edgeName(p)
    const type = EDGE_TYPES[edge]
    const [sourceId, target, sourceType] =
      edge === "serves" ? [p.journey, p.outcome, JOURNEY]
      : edge === "bounds" ? [p.constraint, p.journey ?? p.scenario, CONSTRAINT]
      : edge === "for" ? [p.intent, p.persona, INTENT]
      : [p.scenario, edge === "by" ? p.persona : edge === "in" ? p.journey : p.state, SCENARIO]
    if (typeof sourceId !== "string" || typeof target !== "string") return fail(`${edge} takes its source and target ids`)
    const source = getNode(snap, sourceId, sourceType)
    const edges = source.edges.filter((e) => !(e.type === type && e.to === target))
    if (edges.length === source.edges.length) fail(`${sourceId} has no ${edge} ${target}`)
    if (type === BY && !edges.some((e) => e.type === BY)) fail(`${target} is its last persona on ${sourceId}; link another first`)
    if (type === ARRIVES) fail(`${sourceId} needs an arrival; link another arrives to replace it`)
    return { changes: [Put({ ...source, edges })], message: `unlinked ${sourceId} ${edge} ${target}` }
  },
}

const remove: Op = {
  name: "remove",
  description: "Remove a node nothing references; a statement with the edges to it; a scenario or journey with the bounds edges to it; an intent without statements.",
  run: (p, snap) => {
    const id = reqStr(p, "id")
    const n = snap.nodes.get(id) ?? fail(`no node ${id}`)
    const dropEdgesTo = (sources: ReadonlyArray<string>, keep: (e: Node["edges"][number]) => boolean) =>
      [...new Set(sources)].flatMap((s) => {
        const src = snap.nodes.get(s)
        return src === undefined ? [] : [Put({ ...src, edges: src.edges.filter(keep) })]
      })
    if (isStatement(n)) return { changes: [...dropEdgesTo(inbound(snap, id).map((e) => e.from), (e) => e.to !== id), Remove(id)], message: `removed ${id}` }
    if (n.type === INTENT) {
      const own = n.edges.filter((e) => e.type === HAS).map((e) => e.to)
      if (own.length > 0) fail(`${id} has statements ${own.join(", ")}; remove them first`)
    }
    const users = inbound(snap, id).filter((e) => e.edge.type !== BOUNDS).map((e) => e.from)
    if (users.length > 0) fail(`${id} is used by ${[...new Set(users)].join(", ")}; relink or remove them first`)
    const bounding = dropEdgesTo(inbound(snap, id, BOUNDS).map((e) => e.from), (e) => !(e.type === BOUNDS && e.to === id))
    return { changes: [...bounding, Remove(id)], message: `removed ${id}` }
  },
}

const STATUS = ["draft", "accepted"] as const

const addIntent: Op = {
  name: "add-intent",
  description: "Add an intent: {title, problem?, status?: draft|accepted}.",
  run: (p, snap) => {
    const title = reqStr(p, "title")
    const problem = p.problem === undefined ? undefined : typeof p.problem === "string" ? p.problem : fail("problem must be a string")
    const status = oneOf(p, "status", STATUS) ?? "draft"
    const id = nextId(snap, "I")
    return { changes: [Put({ id, type: INTENT, props: { title, ...(problem !== undefined ? { problem } : {}), status }, edges: [] })], message: `created ${id}` }
  },
}

const editIntent: Op = {
  name: "edit-intent",
  description: "Change an intent's title, problem or status.",
  run: (p, snap) => {
    optStr(p, "title"), oneOf(p, "status", STATUS)
    return updated(getNode(snap, p.id, INTENT), pick(p, ["title", "problem", "status"]))
  },
}

/** A new statement: the node, and its intent with the has edge. */
const addTo = (snap: Snapshot, intent: unknown, type: string, prefix: string, props: Node["props"]) => {
  const i = getNode(snap, intent, INTENT)
  const id = nextId(snap, prefix)
  return { id, changes: [Put({ id, type, props, edges: [] }), Put({ ...i, edges: [...i.edges, { type: HAS, to: id }] })] }
}

const statementOps = (name: string, type: string, prefix: string, what: string): ReadonlyArray<Op> => [
  {
    name: name === "question" ? "ask-question" : `add-${name}`,
    description: `Add ${what} to an intent: {intent, text}.`,
    run: (p, snap) => {
      const r = addTo(snap, p.intent, type, prefix, { text: reqStr(p, "text") })
      return { changes: r.changes, message: `created ${r.id} in ${String(p.intent)}` }
    },
  },
  {
    name: `edit-${name}`,
    description: `Reword ${what}: {id, text}.`,
    run: (p, snap) => updated(getNode(snap, p.id, type), { text: reqStr(p, "text") }),
  },
]

const answerQuestion: Op = {
  name: "answer-question",
  description: "Answer a question: {id, answer, as?: outcome|constraint}. With as, the answer also becomes a statement of the same intent.",
  run: (p, snap) => {
    const q = getNode(snap, p.id, QUESTION)
    const answer = reqStr(p, "answer")
    const as = oneOf(p, "as", ["outcome", "constraint"] as const)
    const answered = Put({ ...q, props: { ...q.props, answer } })
    if (as === undefined) return { changes: [answered], message: `answered ${q.id}` }
    const intent = inbound(snap, q.id, HAS)[0]?.from ?? fail(`${q.id} is in no intent`)
    const r = addTo(snap, intent, as === "outcome" ? OUTCOME : CONSTRAINT, as === "outcome" ? "O" : "K", { text: answer })
    return { changes: [answered, ...r.changes], message: `answered ${q.id}; created ${r.id} in ${intent}` }
  },
}

export const OPS: ReadonlyArray<Op> = [
  addState, editState, addPersona, editPersona, addJourney, editJourney, addScenario, editScenario, link, unlink, remove,
  addIntent, editIntent,
  ...statementOps("outcome", OUTCOME, "O", "an outcome (one result the intent wants for its users)"),
  ...statementOps("constraint", CONSTRAINT, "K", "a constraint (one rule that must hold where it bounds)"),
  ...statementOps("question", QUESTION, "Q", "an open question (one thing not decided yet)"),
  answerQuestion,
]

/** Entity refs in params (`gherkin/state:ST-0002@abc`) mean their bare ids. */
export const bareIds = (v: unknown): unknown => {
  if (typeof v === "string") return /^[a-z][a-z0-9-]*\/[a-z][a-z0-9-]*:([A-Za-z0-9._-]+)(@[0-9a-f]+)?$/.exec(v)?.[1] ?? v
  if (Array.isArray(v)) return v.map(bareIds)
  if (isObj(v)) return Object.fromEntries(Object.entries(v).map(([k, x]) => [k, bareIds(x)]))
  return v
}

/** Runs one named operation. Throws OpError on an unknown name or bad params. */
export const runOp = (name: string, params: unknown, snap: Snapshot): OpResult => {
  const op = OPS.find((o) => o.name === name) ?? fail(`${name} is not an operation; known: ${OPS.map((o) => o.name).join(", ")}`)
  const p = bareIds(params ?? {})
  return op.run(isObj(p) ? p : fail(`${name}: params must be an object`), snap)
}

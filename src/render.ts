/** The Gherkin-inspired text view (§7) and the intent view (§9.5). */
import { inbound, type Node, out, type Snapshot } from "./graph.ts"
import { ARRIVES, BOUNDS, BY, CONSTRAINT, FOR, GIVEN, IN, intents, labelOf, nameOf, OUTCOME, QUESTION, scenarios, SERVES, statementsOf, states, text, THEN } from "./model.ts"

const missing = (id: string) => `<missing ${id}>`

export const renderScenario = (snap: Snapshot, scenario: Node): string => {
  const targets = (type: string) => out(snap, scenario.id, type).map((e) => e.to)
  const word = (id: string, f: (n: Node) => string) => { const n = snap.nodes.get(id); return n === undefined ? missing(id) : f(n) }
  const line = (keyword: string, id: string) => `  ${keyword.padEnd(5)} ${word(id, text)}  # ${id}`
  const by = targets(BY)
  const tags = targets(IN)
  return [
    `${scenario.id} ${String(scenario.props.title)}`,
    ...(scenario.props.planned === true ? ["  Status planned"] : []),
    ...(by.length > 0 ? [`  By    ${by.map((id) => word(id, nameOf)).join(", ")}  # ${by.join(", ")}`] : []),
    ...(tags.length > 0 ? [`  In    ${tags.map((id) => word(id, nameOf)).join(", ")}  # ${tags.join(", ")}`] : []),
    ...[...targets(ARRIVES), ...targets(GIVEN)].map((id, i) => line(i === 0 ? "Given" : "And", id)),
    `  When  ${String(scenario.props.when)}`,
    ...targets(THEN).map((id, i) => line(i === 0 ? "Then" : "And", id)),
  ].join("\n")
}

const KEYWORD: Readonly<Record<string, string>> = { [OUTCOME]: "Outcome", [CONSTRAINT]: "Constraint", [QUESTION]: "Question" }

export const renderIntent = (snap: Snapshot, intent: Node): string => {
  const pad = (k: string) => k.padEnd(10)
  const name = (id: string) => { const n = snap.nodes.get(id); return n === undefined ? missing(id) : labelOf(n) }
  const fors = out(snap, intent.id, FOR).map((e) => e.to)
  const line = (s: Node) => {
    const served = inbound(snap, s.id, SERVES).map((e) => e.from).sort()
    const bounds = s.edges.filter((e) => e.type === BOUNDS).map((e) => e.to)
    const why =
      s.type === OUTCOME ? ` ← ${served.length > 0 ? served.join(", ") : "no journey"}`
      : s.type === CONSTRAINT ? (bounds.length > 0 ? ` → ${bounds.join(", ")}` : "")
      : s.props.answer !== undefined ? ` (answered: ${String(s.props.answer)})` : " (open)"
    return `  ${pad(KEYWORD[s.type] ?? s.type)} ${text(s)}  # ${s.id}${why}`
  }
  return [
    `${intent.id} ${String(intent.props.title)}`,
    `  ${pad("Status")} ${String(intent.props.status)}`,
    ...(fors.length > 0 ? [`  ${pad("For")} ${fors.map(name).join(", ")}  # ${fors.join(", ")}`] : []),
    ...statementsOf(snap, intent.id).map(line),
  ].join("\n")
}

/** Every scenario (or those touching `focus`), then unused states. Intents only when one, or a statement of it, is in focus. */
export const render = (snap: Snapshot, focus?: ReadonlySet<string>): string => {
  const shown = scenarios(snap).filter((c) => focus === undefined || focus.has(c.id) || c.edges.some((e) => focus.has(e.to)))
  const unused = states(snap).filter((s) => inbound(snap, s.id).length === 0 && (focus === undefined || focus.has(s.id)))
  const shownIntents = focus === undefined ? [] : intents(snap).filter((i) => focus.has(i.id) || statementsOf(snap, i.id).some((s) => focus.has(s.id)))
  const parts = [...shownIntents.map((i) => renderIntent(snap, i)), ...shown.map((c) => renderScenario(snap, c))]
  if (unused.length > 0) parts.push(["States without scenarios:", ...unused.map((s) => `  ${s.id} ${text(s)}`)].join("\n"))
  if (parts.length === 0) return focus === undefined ? "No scenarios yet." : "Nothing in focus."
  return parts.join("\n\n")
}

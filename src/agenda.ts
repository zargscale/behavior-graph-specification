/** The completeness agenda (§5.4) and the coverage agenda (§9.4): questions, not errors. */
import { byType, inbound, type Snapshot } from "./graph.ts"
import { ARRIVES, BY, GIVEN, intents, JOURNEY, nameOf, OUTCOME, personas, QUESTION, scenarios, SERVES, similarity, statementsOf, states, text, THEN } from "./model.ts"

export interface AgendaItem {
  readonly id: string
  readonly title: string
  readonly detail: string
  readonly about: ReadonlyArray<string>
  /** 1 is most urgent. */
  readonly priority: number
}

const some = (ids: ReadonlyArray<string>) => `${ids.slice(0, 20).join(", ")}${ids.length > 20 ? ` and ${ids.length - 20} more` : ""}`

export const agenda = (snap: Snapshot): ReadonlyArray<AgendaItem> => {
  const all = states(snap)
  if (all.length === 0 && scenarios(snap).length === 0)
    return [{ id: "gherkin:empty", title: "No requirements yet", detail: "Describe where a user starts and their first action.", about: [], priority: 1 }, ...personaItems(snap), ...intentItems(snap)]
  const items: Array<AgendaItem> = []
  for (const s of all) {
    if ([ARRIVES, GIVEN, THEN].every((e) => inbound(snap, s.id, e).length === 0)) {
      items.push({ id: `gherkin:unused-state:${s.id}`, title: `Nothing uses "${text(s)}"`, detail: `No scenario has ${s.id} as its Given, an And or a Then. Use it in a scenario, or remove it.`, about: [s.id], priority: 2 })
      continue
    }
    if (s.props.terminal !== true && inbound(snap, s.id, ARRIVES).length === 0 && inbound(snap, s.id, GIVEN).length === 0)
      items.push({ id: `gherkin:dead-end:${s.id}`, title: `What can the user do when "${text(s)}"?`, detail: `No scenario starts from ${s.id}. Add one that starts from ${s.id}, or mark it terminal when nothing needs to follow.`, about: [s.id], priority: 2 })
    if (s.props.entry !== true && inbound(snap, s.id, THEN).length === 0)
      items.push({ id: `gherkin:unreached:${s.id}`, title: `How does the user reach "${text(s)}"?`, detail: `No scenario leads to ${s.id}. Add a scenario whose Then is ${s.id}, or mark it an entry state.`, about: [s.id], priority: 2 })
  }
  for (const [i, a] of all.entries())
    for (const b of all.slice(i + 1))
      if (similarity(text(a), text(b)) >= 0.8)
        items.push({ id: `gherkin:near-duplicate:${a.id}:${b.id}`, title: `Are "${text(a)}" and "${text(b)}" the same state?`, detail: `${a.id} and ${b.id} have nearly the same text.`, about: [a.id, b.id], priority: 3 })
  return [...items, ...personaItems(snap), ...intentItems(snap)]
}

const personaItems = (snap: Snapshot): ReadonlyArray<AgendaItem> => {
  const items: Array<AgendaItem> = []
  const ps = personas(snap)
  if (ps.length === 0) items.push({ id: "gherkin:no-personas", title: "Who uses this product?", detail: "No personas yet. Add each actor with add-persona.", about: [], priority: 1 })
  const nobody = scenarios(snap).filter((c) => !c.edges.some((e) => e.type === BY)).map((c) => c.id)
  if (nobody.length > 0)
    items.push({ id: "gherkin:who-does", title: `Who does ${nobody.length} scenario${nobody.length === 1 ? "" : "s"}?`, detail: `${some(nobody)} name no persona. Link each with link {edge: "by", scenario, persona}.`, about: nobody, priority: 2 })
  for (const p of ps)
    if (inbound(snap, p.id, BY).length === 0) items.push({ id: `gherkin:unused-persona:${p.id}`, title: `Nobody acts as ${nameOf(p)}`, detail: `No scenario names ${p.id}. Link scenarios to it with link {edge: "by"}, or remove it.`, about: [p.id], priority: 3 })
  return items
}

const intentItems = (snap: Snapshot): ReadonlyArray<AgendaItem> => {
  const items: Array<AgendaItem> = []
  const outcomes = byType(snap, OUTCOME)
  const uncovered = outcomes.filter((o) => inbound(snap, o.id, SERVES).length === 0)
  if (uncovered.length > 0)
    items.push({
      id: "gherkin:uncovered",
      title: `Which journey delivers ${uncovered.length} outcome${uncovered.length === 1 ? "" : "s"}?`,
      detail: `${some(uncovered.map((o) => `${o.id} "${text(o)}"`))}: no journey serves them. Link one with link {edge: "serves", journey, outcome}.`,
      about: uncovered.map((o) => o.id),
      priority: 2,
    })
  const unserving = outcomes.length === 0 ? [] : byType(snap, JOURNEY).filter((j) => !j.edges.some((e) => e.type === SERVES))
  if (unserving.length > 0)
    items.push({ id: "gherkin:unserving", title: `What do ${unserving.length} journey${unserving.length === 1 ? "" : "s"} serve?`, detail: `${unserving.map((j) => `${j.id} ${nameOf(j)}`).join(", ")} serve no outcome.`, about: unserving.map((j) => j.id), priority: 3 })
  for (const q of byType(snap, QUESTION))
    if (q.props.answer === undefined) items.push({ id: `gherkin:question:${q.id}`, title: text(q), detail: `${q.id} is open. Answer it with answer-question (as an outcome or a constraint when it decides one).`, about: [q.id], priority: 2 })
  for (const i of intents(snap))
    if (!statementsOf(snap, i.id).some((s) => s.type === OUTCOME)) items.push({ id: `gherkin:no-outcome:${i.id}`, title: `What should "${String(i.props.title)}" achieve?`, detail: `${i.id} has no outcome yet. Add one with add-outcome.`, about: [i.id], priority: 2 })
  return items
}

/** Failure-case candidates: states left in only one way, most-reached first (§5.4). */
export const suggest = (snap: Snapshot): ReadonlyArray<AgendaItem> =>
  states(snap)
    .flatMap((s) => {
      const leaving = inbound(snap, s.id, ARRIVES)
      const scenario = leaving.length === 1 ? snap.nodes.get(leaving[0]!.from) : undefined
      return scenario === undefined ? [] : [{ s, scenario, reached: inbound(snap, s.id, THEN).length }]
    })
    .sort((a, b) => b.reached - a.reached || a.s.id.localeCompare(b.s.id))
    .map(({ s, scenario }, i) => ({
      id: `gherkin:one-way:${s.id}`,
      title: `A failure case for "${String(scenario.props.title ?? scenario.id)}"`,
      detail: `${scenario.id} is the only way on from ${s.id}. Given ${text(s)}. When ${String(scenario.props.when ?? "")}. Then ${scenario.edges
        .filter((e) => e.type === THEN)
        .map((e) => { const t = snap.nodes.get(e.to); return t === undefined ? e.to : text(t) })
        .join(", and ")}. Can it fail or go another way the user must handle?`,
      about: [s.id, scenario.id],
      priority: i + 1,
    }))

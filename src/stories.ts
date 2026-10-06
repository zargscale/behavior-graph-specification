/** Story planning (§12): finite walks through the derived scenario flow. */
import { byType, inbound, out, type Snapshot } from "./graph.ts"
import { ARRIVES, IN, JOURNEY, nextOf, scenarios, THEN } from "./model.ts"

export type Strategy = "teleport" | "edge-pair" | "journey"
export const STRATEGIES: ReadonlyArray<Strategy> = ["teleport", "edge-pair", "journey"]

export interface Stories {
  readonly stories: ReadonlyArray<ReadonlyArray<string>>
  /** Scenarios no root reaches, plus requirements left uncovered. */
  readonly unreachable: number
}

/**
 * Edge-pair over some scenarios (all when `members` is undefined): root-to-leaf walks covering every reachable scenario,
 * every two in a row and every three in a row, by greedy set cover. Loopbacks are dropped by a DFS from the roots.
 */
const edgePair = (snap: Snapshot, members?: ReadonlySet<string>): Stories => {
  const inside = (c: string) => members === undefined || members.has(c)
  const all = scenarios(snap).map((c) => c.id).filter(inside)
  const roots = all.filter((c) => {
    const s = out(snap, c, ARRIVES)[0]?.to
    return s !== undefined && (snap.nodes.get(s)?.props.entry === true || inbound(snap, s, THEN).filter((e) => inside(e.from)).length === 0)
  })
  const next = new Map<string, Array<string>>()
  const state = new Map<string, "open" | "done">()
  const visit = (c: string) => {
    state.set(c, "open")
    const kept: Array<string> = []
    for (const n of nextOf(snap, c).filter(inside)) {
      if (state.get(n) === "open") continue
      kept.push(n)
      if (!state.has(n)) visit(n)
    }
    next.set(c, kept)
    state.set(c, "done")
  }
  for (const r of roots) if (!state.has(r)) visit(r)
  const need = new Set<string>(next.keys())
  for (const [c, ns] of next)
    for (const n of ns) {
      need.add(`${c}>${n}`)
      for (const m of next.get(n) ?? []) need.add(`${c}>${n}>${m}`)
    }
  const stories: Array<Array<string>> = []
  while (need.size > 0) {
    const memo = new Map<string, { gain: number; path: Array<string> }>()
    // The most uncovered requirements a walk from c (arrived from p) can still cover to a leaf.
    const f = (p: string | undefined, c: string): { gain: number; path: Array<string> } => {
      const key = `${p ?? ""}|${c}`
      const hit = memo.get(key)
      if (hit !== undefined) return hit
      const own = need.has(c) ? 1 : 0
      let best = { gain: own, path: [c] }
      let first = true
      for (const n of next.get(c) ?? []) {
        const rest = f(c, n)
        const gain = own + (need.has(`${c}>${n}`) ? 1 : 0) + (p !== undefined && need.has(`${p}>${c}>${n}`) ? 1 : 0) + rest.gain
        if (first || gain > best.gain) best = { gain, path: [c, ...rest.path] }
        first = false
      }
      memo.set(key, best)
      return best
    }
    const pick = roots.map((r) => f(undefined, r)).sort((a, b) => b.gain - a.gain)[0]
    if (pick === undefined || pick.gain === 0) break
    stories.push(pick.path)
    pick.path.forEach((c, i) => {
      need.delete(c)
      if (i > 0) need.delete(`${pick.path[i - 1]}>${c}`)
      if (i > 1) need.delete(`${pick.path[i - 2]}>${pick.path[i - 1]}>${c}`)
    })
  }
  return { stories, unreachable: all.filter((c) => !next.has(c)).length + need.size }
}

/** With focus, only stories through a focused scenario; a focused journey means its scenarios. */
export const planStories = (snap: Snapshot, strategy: Strategy, focused?: ReadonlySet<string>): Stories => {
  const focus = focused === undefined ? undefined : new Set([...focused].flatMap((id) => (snap.nodes.get(id)?.type === JOURNEY ? inbound(snap, id, IN).map((e) => e.from) : [id])))
  const all = scenarios(snap).map((c) => c.id)
  const through = (s: ReadonlyArray<ReadonlyArray<string>>) => s.filter((x) => focus === undefined || x.some((c) => focus.has(c)))
  if (strategy === "teleport") return { stories: all.filter((c) => focus === undefined || focus.has(c)).map((c) => [c]), unreachable: 0 }
  if (strategy === "edge-pair") {
    const r = edgePair(snap)
    return { stories: through(r.stories), unreachable: r.unreachable }
  }
  const journeys = byType(snap, JOURNEY).map((j) => ({ id: j.id, members: new Set(inbound(snap, j.id, IN).map((e) => e.from)) }))
  const stories: Array<ReadonlyArray<string>> = []
  let unreachable = 0
  for (const j of journeys) {
    const r = edgePair(snap, j.members)
    stories.push(...r.stories)
    unreachable += r.unreachable
  }
  // Handoffs: from one journey's scenario to a scenario of another journey (not also in the first), each once.
  const seams = new Set<string>()
  for (const j of journeys)
    for (const c of j.members)
      for (const n of nextOf(snap, c)) if (!j.members.has(n) && journeys.some((o) => o !== j && o.members.has(n))) seams.add(`${c}>${n}`)
  stories.push(...[...seams].sort().map((x) => x.split(">")))
  const grouped = new Set(journeys.flatMap((j) => [...j.members]))
  stories.push(...all.filter((c) => !grouped.has(c)).map((c) => [c]))
  return { stories: through(stories), unreachable }
}

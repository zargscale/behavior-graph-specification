/** The acceptance checks of §16, and the fingerprint matrix of §11.2. */
import { expect, test } from "bun:test"
import {
  agenda, applyDraft, checkAll, type Draft, dryRun, empty, make, type Node, nextOf, OpError, parseRef, planStories, refProblem, render, revision, runOp, scenarioVersion, type Snapshot,
} from "../src/index.ts"

const visitor = { tool: "add-persona", params: { name: "Visitor", kind: "human", text: "A person on the website." } }
const build = (draft: Draft, from: Snapshot = empty): Snapshot => {
  const a = applyDraft(from, draft)
  expect(a.problems).toEqual([])
  return a.snapshot
}
const scenario = (title: string, arrives: object, then: ReadonlyArray<object>, extra: object = {}) => ({ tool: "add-scenario", params: { title, when: `the visitor ${title.toLowerCase()}`, by: [{ name: "Visitor" }], arrives, then, ...extra } })
/** The snapshot with some nodes replaced as stored, bypassing the operations: an import. */
const imported = (s: Snapshot, ...nodes: ReadonlyArray<Node>) => make([...s.nodes.values(), ...nodes].reverse().filter((n, i, all) => all.findIndex((x) => x.id === n.id) === i))
const base = build([visitor, scenario("Opens the form", { text: "the home page is shown" }, [{ text: "the form is shown" }])])

test("text references reuse one state after normalization", () => {
  const s = build([scenario("Submits", { text: "The form is shown." }, [{ text: "the form is shown" }])], base)
  expect([...s.nodes.values()].filter((n) => n.type === "gherkin/state").length).toBe(2)
})

test("rewording a state keeps its id and every scenario renders the new text", () => {
  const s = build([scenario("Submits", { id: "ST-0002" }, [{ text: "done" }]), scenario("Cancels", { id: "ST-0002" }, [{ text: "cancelled" }]), { tool: "edit-state", params: { id: "ST-0002", text: "the sign-up form is shown" } }], base)
  expect(render(s).match(/the sign-up form is shown {2}# ST-0002/g)?.length).toBe(3)
})

test("two outcome states render as Then and And", () => {
  const s = build([scenario("Submits", { id: "ST-0002" }, [{ text: "the account is ready" }, { text: "an email is sent" }])], base)
  expect(render(s, new Set(["S-0002"]))).toContain("Then  the account is ready  # ST-0003\n  And   an email is sent  # ST-0004")
})

test("two scenarios with one arrival branch without a stored edge; a loop terminates", () => {
  const s = build([scenario("Submits", { id: "ST-0002" }, [{ text: "done" }]), scenario("Retries", { id: "ST-0002" }, [{ id: "ST-0002" }, { text: "an error is shown" }])], base)
  expect(nextOf(s, "S-0001")).toEqual(["S-0002", "S-0003"])
  expect(nextOf(s, "S-0003")).toEqual(["S-0002", "S-0003"])
  expect(planStories(s, "edge-pair").stories.length).toBeGreaterThan(0)
  expect(render(s)).toContain("S-0003")
})

test("edge counts out of range are rejected", () => {
  const states = (n: number) => Array.from({ length: n }, (_, i) => ({ text: `fact ${i} holds` }))
  for (const params of [{ then: [] }, { then: states(6) }, { then: states(1), given: states(4) }]) {
    const r = dryRun(base, [scenario("Submits", { id: "ST-0002" }, params.then, params)])
    expect(r.ok).toBe(false)
    expect(r.problems[0]).toMatch(/edges; it needs/)
  }
})

test("duplicate edges, wrong endpoints and missing targets are specific errors", () => {
  const s0 = base.nodes.get("S-0001")!
  const codes = (node: Node) => checkAll(imported(base, node)).map((f) => f.code)
  expect(codes({ ...s0, edges: [...s0.edges, s0.edges[2]!] })).toContain("duplicate-edge")
  expect(codes({ ...s0, edges: [...s0.edges, { type: "gherkin/then", to: "P-0001" }] })).toContain("edge-target")
  expect(codes({ ...s0, edges: [...s0.edges, { type: "gherkin/then", to: "ST-9999" }] })).toContain("missing-target")
})

test("a 16-word clause and a standalone if are rejected; and/or only warn", () => {
  const sixteen = Array.from({ length: 16 }, () => "word").join(" ")
  expect(dryRun(base, [{ tool: "add-state", params: { text: sixteen } }]).problems[0]).toMatch(/16 words/)
  expect(dryRun(base, [{ tool: "add-state", params: { text: "it shows if ready" } }]).ok).toBe(false)
  const warned = dryRun(base, [{ tool: "add-state", params: { text: "cats and dogs are shown" } }, scenario("Picks one or two", { id: "ST-0002" }, [{ id: "ST-0003" }])])
  expect(warned.ok).toBe(true)
  expect(warned.warnings.map((w) => w.code).sort()).toEqual(["alternatives", "and-chaining"])
})

test("authoring refuses a scenario without actors and unlinking its last actor", () => {
  expect(() => runOp("add-scenario", { title: "x", when: "x", arrives: { id: "ST-0001" }, then: [{ id: "ST-0002" }] }, base)).toThrow(OpError)
  expect(() => runOp("unlink", { edge: "by", scenario: "S-0001", persona: "P-0001" }, base)).toThrow(/last persona/)
})

test("an imported scenario without actors stays inspectable and raises an agenda item", () => {
  const s0 = base.nodes.get("S-0001")!
  const s = imported(base, { ...s0, edges: s0.edges.filter((e) => e.type !== "gherkin/by") })
  expect(checkAll(s).filter((f) => f.severity === "error")).toEqual([])
  expect(agenda(s).map((i) => i.id)).toContain("gherkin:who-does")
})

test("one scenario in two journeys shows in both", () => {
  const s = build([{ tool: "add-journey", params: { name: "Sign up" } }, { tool: "add-journey", params: { name: "Browse" } }, { tool: "link", params: { edge: "in", scenario: "S-0001", journey: "Sign up" } }, { tool: "link", params: { edge: "in", scenario: "S-0001", journey: "J-0002" } }], base)
  expect(render(s, new Set(["S-0001"]))).toContain("In    Sign up, Browse  # J-0001, J-0002")
  expect(planStories(s, "journey").stories).toEqual([["S-0001"], ["S-0001"]])
})

test("removing a referenced node is refused with its dependents", () => {
  expect(() => runOp("remove", { id: "ST-0001" }, base)).toThrow(/used by S-0001/)
  expect(() => runOp("remove", { id: "P-0001" }, base)).toThrow(/used by S-0001/)
})

test("an invalid draft leaves the snapshot unchanged", () => {
  const r = dryRun(base, [{ tool: "remove", params: { id: "ST-0001" } }])
  expect(r.ok).toBe(false)
  expect(base.nodes.has("ST-0001")).toBe(true)
})

test("intents: statement ownership, removal and coverage", () => {
  const s = build([{ tool: "add-intent", params: { title: "Self-service sign-up" } }, { tool: "add-outcome", params: { intent: "I-0001", text: "Visitors sign up alone." } }], base)
  expect(agenda(s).map((i) => i.id)).toContain("gherkin:uncovered")
  expect(() => runOp("remove", { id: "I-0001" }, s)).toThrow(/has statements O-0001/)
  const twoOwners = imported(s, { id: "I-0002", type: "gherkin/intent", props: { title: "Other", status: "draft" }, edges: [{ type: "gherkin/has", to: "O-0001" }] })
  expect(checkAll(twoOwners).map((f) => f.code)).toContain("statement-owner")
  expect(checkAll(imported(s, { id: "O-0002", type: "gherkin/outcome", props: { text: "Nobody owns this." }, edges: [] })).map((f) => f.code)).toContain("statement-owner")
  expect(runOp("answer-question", { id: "Q-0001", answer: "yes" }, build([{ tool: "ask-question", params: { intent: "I-0001", text: "Does it expire?" } }], s)).changes.length).toBe(1)
})

test("§11.2: which changes move the node revision and the scenario version", () => {
  const rev = (s: Snapshot) => revision(s.nodes.get("S-0001")!)
  const ver = (s: Snapshot) => scenarioVersion(s, "S-0001")
  const rows: ReadonlyArray<[string, Draft, boolean, boolean]> = [
    ["title", [{ tool: "edit-scenario", params: { id: "S-0001", title: "Opens it" } }], true, true],
    ["state text", [{ tool: "edit-state", params: { id: "ST-0002", text: "the sign-up form is shown" } }], false, true],
    ["state flag", [{ tool: "edit-state", params: { id: "ST-0002", terminal: true } }], false, false],
    ["persona name", [{ tool: "edit-persona", params: { id: "P-0001", name: "Guest" } }], false, true],
    ["persona description", [{ tool: "edit-persona", params: { id: "P-0001", text: "Someone else entirely." } }], false, false],
    ["by", [{ tool: "add-persona", params: { name: "Admin", kind: "human", text: "Staff." } }, { tool: "link", params: { edge: "by", scenario: "S-0001", persona: "Admin" } }], true, true],
    ["journey", [{ tool: "add-journey", params: { name: "Sign up" } }, { tool: "link", params: { edge: "in", scenario: "S-0001", journey: "Sign up" } }], true, false],
    ["planned", [{ tool: "edit-scenario", params: { id: "S-0001", planned: true } }], true, false],
  ]
  for (const [name, draft, revChanges, verChanges] of rows) {
    const after = build(draft, base)
    expect([name, rev(after) !== rev(base), ver(after) !== ver(base)]).toEqual([name, revChanges, verChanges])
  }
})

test("refs: malformed ones are rejected with a reason", () => {
  expect(refProblem("gherkin/scenario:S-1@xyz")).toMatch(/non-hex/)
  expect(refProblem("scenario:S-1")).toMatch(/not a type/)
  expect(parseRef("gherkin/scenario:S-0002@e30089cbc147")).toEqual({ type: "gherkin/scenario", id: "S-0002", version: "e30089cbc147" })
})

/** The complete example (§8): every output the README shows. Revisions, rendering, agenda, stories and dry runs also match zarg-v2. */
import { expect, test } from "bun:test"
import { readFileSync } from "node:fs"
import { affected, agenda, applyDraft, checkAll, dryRun, load, planStories, render, resolve, revision, scenarioVersion, suggest } from "../src/index.ts"

const { snapshot: snap, problems } = load("examples/registration")
const draft = JSON.parse(readFileSync("examples/registration/draft.json", "utf8"))

test("loads cleanly, with no findings", () => {
  expect(problems).toEqual([])
  expect(snap.nodes.size).toBe(16)
  expect(checkAll(snap)).toEqual([])
})

test("renders the scenarios and the intent as the spec shows", () => {
  expect(render(snap, new Set(["S-0003"]))).toBe(`S-0003 Visitor submits incomplete details
  Status planned
  By    Visitor  # P-0001
  In    Create an account  # J-0001
  Given the registration form is shown  # ST-0002
  When  the visitor submits incomplete registration details
  Then  the registration form is shown  # ST-0002
  And   a validation message identifies missing details  # ST-0005`)
  expect(render(snap, new Set(["I-0001"])).split("\n\n")[0]).toBe(`I-0001 Self-service sign-up
  Status     accepted
  For        Visitor  # P-0001
  Outcome    A visitor creates an account without contacting support.  # O-0001 ← J-0001
  Constraint A confirmation email never contains the visitor's password.  # K-0001 → S-0002
  Question   Does an unconfirmed account expire?  # Q-0001 (open)`)
})

test("agenda and suggestions", () => {
  expect(agenda(snap).map((i) => i.id)).toEqual(["gherkin:question:Q-0001"])
  expect(suggest(snap).map((i) => i.id)).toEqual(["gherkin:one-way:ST-0001"])
})

test("fingerprints match the recorded ones", () => {
  expect(revision(snap.nodes.get("S-0002")!)).toBe("61113fc7a1a9")
  expect(revision(snap.nodes.get("ST-0002")!)).toBe("034e490894fd")
  expect(["S-0001", "S-0002", "S-0003"].map((id) => scenarioVersion(snap, id))).toEqual(["43b6a6ae8c19", "e30089cbc147", "e130c6f72059"])
  const o = resolve(snap, "gherkin/outcome:O-0001")
  expect("entity" in o && o.entity.ref).toBe("gherkin/outcome:O-0001@eef4445212c9")
})

test("stories", () => {
  const walks = [["S-0001", "S-0003", "S-0002"], ["S-0001", "S-0002"]]
  expect(planStories(snap, "edge-pair")).toEqual({ stories: walks, unreachable: 0 })
  expect(planStories(snap, "journey")).toEqual({ stories: walks, unreachable: 0 })
  expect(planStories(snap, "teleport").stories).toEqual([["S-0001"], ["S-0002"], ["S-0003"]])
})

test("the draft's dry run, impact and new versions", () => {
  const r = dryRun(snap, draft)
  expect({ ...r, warnings: undefined }).toEqual({
    ok: true,
    problems: [],
    touched: ["S-0004", "ST-0002", "ST-0006"],
    scenarios: ["S-0001", "S-0002", "S-0003", "S-0004"],
    messages: ["updated ST-0002", "created S-0004; new states ST-0006", "linked S-0004 in J-0001"],
    next: { scenario: "S-0005", state: "ST-0007", journey: "J-0002", persona: "P-0002" },
    warnings: undefined,
  })
  const after = applyDraft(snap, draft).snapshot
  expect(affected(snap, after)).toEqual({ scenarios: ["S-0001", "S-0002", "S-0003", "S-0004"], removed: [] })
  // The stored scenario is unchanged; what a tester reads changed (§11.2).
  expect(revision(after.nodes.get("S-0002")!)).toBe("61113fc7a1a9")
  expect(["S-0001", "S-0002", "S-0003", "S-0004"].map((id) => scenarioVersion(after, id))).toEqual(["cecf1a175957", "05352f0487ea", "cc66f1f352b4", "a8d4b19eeadb"])
})

test("a faulty draft reports every problem and is not ok", () => {
  const bad = [
    { tool: "add-scenario", params: { title: "Visitor retries", when: "the visitor submits the form again if it failed", by: [{ name: "Visitor" }], arrives: { text: "The registration form is shown." }, then: [] } },
    { tool: "add-scenario", params: { title: "Visitor retries", when: "the visitor submits the form again if it failed", by: [{ name: "Visitor" }], arrives: { text: "The registration form is shown." }, then: [{ text: "the account is ready and a welcome page is shown" }] } },
    { tool: "add-state", params: { text: "the account is ready" } },
  ]
  const r = dryRun(snap, bad)
  expect(r.ok).toBe(false)
  expect(r.problems).toEqual([
    "add-scenario: S-0004 has 0 then edges; it needs 1-5",
    "add-state: ST-0003 already has this text; use it",
    'S-0004: "the visitor submits the form again if it failed" contains "if"; make one scenario per case instead',
  ])
  expect(r.warnings.map((w) => w.code)).toEqual(["and-chaining"])
})

/** Source documents (§10): config, entry discovery by glob, checksums, status, acceptance, and the audit check. */
import { expect, test } from "bun:test"
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { acceptSources, audit, discover, exitCode, load, loadConfig, runOp, scenarioVersion, sourceStatus, write } from "../src/index.ts"

const project = (files: Record<string, string>) => {
  const root = mkdtempSync(join(tmpdir(), "bgraph-src-"))
  for (const [path, text] of Object.entries(files)) {
    mkdirSync(join(root, path, ".."), { recursive: true })
    writeFileSync(join(root, path), text)
  }
  return root
}
const entry = (...sources: Array<string>) => `---\nsources:\n${sources.map((s) => `  - ${s}`).join("\n")}\n---\n# Entry\n`

test("config is found upward and fills defaults", () => {
  const root = project({ "bgraph.json": '{ "entries": ["specs/*.md"] }', "a/b/.keep": "" })
  const c = loadConfig(join(root, "a/b"))
  expect(c).toMatchObject({ root, graph: ".behavior-graph", entries: ["specs/*.md"], ignore: ["docs"] })
  expect(loadConfig(mkdtempSync(join(tmpdir(), "bgraph-none-"))).file).toBeUndefined()
})

test("many entry documents by glob, each with many sources", () => {
  const root = project({
    "BEHAVIOR.md": entry("INTENT.md", "docs/stories/*.md"),
    "billing/BEHAVIOR.md": entry("REQUIREMENTS.md", "../INTENT.md", "missing/*.md", "../../outside.md"),
    "billing/REQUIREMENTS.md": "# Billing\n",
    "INTENT.md": "# Intent\n",
    "docs/stories/a.md": "# A\n",
    "docs/stories/b.md": "# B\n",
    "node_modules/x/BEHAVIOR.md": entry("INTENT.md"),
  })
  const d = discover(root, ["**/BEHAVIOR.md"])
  expect(d.entries).toEqual([
    { path: "BEHAVIOR.md", sources: ["INTENT.md", "docs/stories/a.md", "docs/stories/b.md"] },
    { path: "billing/BEHAVIOR.md", sources: ["INTENT.md", "billing/REQUIREMENTS.md"] },
  ])
  expect(d.problems.map((p) => p.message)).toEqual(["missing/*.md matches no file", "../../outside.md is outside the project"])
  const shared = sourceStatus(load(join(root, ".g")).snapshot, root, join(root, ".g"), d).find((s) => s.path === "INTENT.md")!
  expect(shared).toMatchObject({ state: "new", entry: false, entries: ["BEHAVIOR.md", "billing/BEHAVIOR.md"] })
})

test("status moves through new, current, changed, unlisted and missing", () => {
  const root = project({ "BEHAVIOR.md": entry("INTENT.md", "RULES.md"), "INTENT.md": "# Intent\nv1\n", "RULES.md": "# Rules\n" })
  const g = join(root, ".behavior-graph")
  const states = () => Object.fromEntries(sourceStatus(load(g).snapshot, root, g, discover(root, ["BEHAVIOR.md"])).map((s) => [s.path, s.state]))
  expect(states()).toEqual({ "BEHAVIOR.md": "new", "INTENT.md": "new", "RULES.md": "new" })

  acceptSources(load(g).snapshot, root, g, discover(root, ["BEHAVIOR.md"]), ["BEHAVIOR.md", "INTENT.md", "RULES.md"])
  expect(states()).toEqual({ "BEHAVIOR.md": "current", "INTENT.md": "current", "RULES.md": "current" })
  // Line endings do not count as a change.
  writeFileSync(join(root, "INTENT.md"), "# Intent\r\nv1\r\n")
  expect(states()["INTENT.md"]).toBe("current")

  write(g, [{ tool: "add-intent", params: { title: "Sign-up" } }, { tool: "link", params: { edge: "from", node: "I-0001", source: "INTENT.md", section: "Intent" } }])
  writeFileSync(join(root, "INTENT.md"), "# Intent\nv2\n")
  const changed = sourceStatus(load(g).snapshot, root, g, discover(root, ["BEHAVIOR.md"])).find((s) => s.path === "INTENT.md")!
  expect(changed).toMatchObject({ state: "changed", derived: ["I-0001"], previous: `.behavior-graph/sources/${changed.recorded}.md` })
  expect(Bun.file(join(root, changed.previous!)).size).toBeGreaterThan(0)

  writeFileSync(join(root, "BEHAVIOR.md"), entry("INTENT.md"))
  rmSync(join(root, "INTENT.md"))
  expect(states()).toEqual({ "BEHAVIOR.md": "changed", "INTENT.md": "missing", "RULES.md": "unlisted" })
  expect(() => acceptSources(load(g).snapshot, root, g, discover(root, ["BEHAVIOR.md"]), ["RULES.md"])).toThrow(/no longer listed/)
})

test("provenance changes neither scenario versions nor impact, and a source with derived nodes cannot be removed", () => {
  const root = project({ "BEHAVIOR.md": entry("INTENT.md"), "INTENT.md": "# Intent\n" })
  const g = join(root, ".behavior-graph")
  acceptSources(load(g).snapshot, root, g, discover(root, ["BEHAVIOR.md"]), ["INTENT.md"])
  write(g, [
    { tool: "add-persona", params: { name: "Visitor", kind: "human", text: "A visitor." } },
    { tool: "add-scenario", params: { title: "Visitor opens", when: "the visitor opens it", by: ["Visitor"], arrives: { text: "home is shown" }, then: [{ text: "form is shown" }] } },
  ])
  const before = scenarioVersion(load(g).snapshot, "S-0001")
  write(g, [{ tool: "link", params: { edge: "from", node: "S-0001", source: "SRC-0001" } }])
  const snap = load(g).snapshot
  expect(scenarioVersion(snap, "S-0001")).toBe(before!)
  expect(() => runOp("remove", { id: "SRC-0001" }, snap)).toThrow(/used by S-0001/)
  expect(() => runOp("link", { edge: "from", node: "SRC-0001", source: "SRC-0001" }, snap)).toThrow(/only gherkin nodes other than sources/)
})

test("the audit's sources check warns, and fails in strict mode", () => {
  const root = project({ "BEHAVIOR.md": entry("INTENT.md", "nothing/*.md"), "INTENT.md": "# Intent\n" })
  const g = join(root, ".behavior-graph")
  const d = discover(root, ["BEHAVIOR.md"])
  const sources = { status: sourceStatus(load(g).snapshot, root, g, d), problems: d.problems }
  const r = audit({ snapshot: load(g).snapshot, sources })
  expect(r.checks.find((c) => c.name === "sources")?.items.map((i) => i.detail)).toEqual(["nothing/*.md matches no file", "new", "new"])
  expect(exitCode(r)).toBe(0)
  expect(exitCode(audit({ snapshot: load(g).snapshot, sources, strict: true }))).toBe(1)
})

test("cli: init, then sources and accept", () => {
  const root = mkdtempSync(join(tmpdir(), "bgraph-init-"))
  const cli = (...args: Array<string>) => {
    const p = Bun.spawnSync(["bun", join(import.meta.dir, "../src/cli.ts"), ...args], { cwd: root })
    return { code: p.exitCode, out: p.stdout.toString() }
  }
  expect(cli("init").out.trim()).toBe("created bgraph.json, BEHAVIOR.md")
  writeFileSync(join(root, "INTENT.md"), "# Intent\n")
  expect(cli("sources")).toEqual({ code: 1, out: "new       BEHAVIOR.md (entry)\nnew       INTENT.md\n" })
  expect(cli("sources", "--accept-all").code).toBe(0)
  expect(cli("sources")).toEqual({ code: 0, out: "current   BEHAVIOR.md (entry)  # SRC-0001\ncurrent   INTENT.md  # SRC-0002\n" })
})

test("cli: a draft can link from a new document, recorded as evaluated in the same write", () => {
  const root = project({ "bgraph.json": '{ "entries": ["BEHAVIOR.md"] }', "BEHAVIOR.md": entry("INTENT.md"), "INTENT.md": "# Intent\n## Goals\n- Sign up alone.\n" })
  const cli = (...args: Array<string>) => {
    const p = Bun.spawnSync(["bun", join(import.meta.dir, "../src/cli.ts"), ...args], { cwd: root })
    return { code: p.exitCode, out: p.stdout.toString(), err: p.stderr.toString() }
  }
  const draft = [
    { tool: "add-intent", params: { title: "Sign-up" } },
    { tool: "add-outcome", params: { intent: "I-0001", text: "A visitor signs up alone." } },
    { tool: "link", params: { edge: "from", node: "O-0001", source: "INTENT.md", section: "Goals" } },
  ]
  writeFileSync(join(root, "draft.json"), JSON.stringify(draft))
  expect(cli("dry-run", "draft.json").code).toBe(1)
  expect(cli("dry-run", "draft.json", "--accept", "INTENT.md", "--accept", "BEHAVIOR.md").code).toBe(0)
  expect(cli("sources").code).toBe(1)
  expect(cli("apply", "draft.json", "--accept", "INTENT.md", "--accept", "BEHAVIOR.md").code).toBe(0)
  expect(cli("sources", "--json").out).toContain('"derived": [\n        "O-0001"\n      ]')
  expect(cli("sources").code).toBe(0)
  expect(cli("audit", "--no-code").code).toBe(0)
})

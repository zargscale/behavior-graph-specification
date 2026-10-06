/** The file store (§14), the write boundary (§6.2, §6.3), and the CLI end to end. */
import { expect, test } from "bun:test"
import { cpSync, mkdtempSync, readdirSync, readFileSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { canonical, GraphError, load, nextId, revision, write } from "../src/index.ts"

const fresh = () => {
  const dir = mkdtempSync(join(tmpdir(), "bgraph-"))
  cpSync("examples/registration", dir, { recursive: true })
  return dir
}
const code = (f: () => unknown) => {
  try {
    f()
  } catch (e) {
    return e instanceof GraphError ? e.code : String(e)
  }
  return "ok"
}

test("example files are in canonical form", () => {
  for (const name of readdirSync("examples/registration/nodes")) {
    const file = `examples/registration/nodes/${name}`
    expect(canonical(JSON.parse(readFileSync(file, "utf8")))).toBe(readFileSync(file, "utf8"))
  }
})

test("write applies a valid draft and refuses an invalid one without touching files", () => {
  const dir = fresh()
  const w = write(dir, JSON.parse(readFileSync("examples/registration/draft.json", "utf8")))
  expect(w.diff.added.map((n) => n.id)).toEqual(["S-0004", "ST-0006"])
  expect(load(dir).snapshot.nodes.get("ST-0002")?.props.text).toBe("the sign-up form is shown")
  const before = readdirSync(join(dir, "nodes")).sort()
  expect(code(() => write(dir, [{ tool: "remove", params: { id: "ST-0001" } }]))).toBe("rejected")
  expect(readdirSync(join(dir, "nodes")).sort()).toEqual(before)
})

test("expected revisions: stale and absent", () => {
  const dir = fresh()
  const edit = [{ tool: "edit-state", params: { id: "ST-0002", text: "the sign-up form is shown" } }]
  expect(code(() => write(dir, edit, { "ST-0002": "000000000000" }))).toBe("stale-node")
  expect(code(() => write(dir, edit, { "ST-0002": "034e490894fd", "ST-0006": "absent" }))).toBe("ok")
  expect(revision(load(dir).snapshot.nodes.get("ST-0002")!)).toBe("6d4d80f86864")
})

test("a damaged file is reported, its id reserved, and unrelated writes still work", () => {
  const dir = fresh()
  writeFileSync(join(dir, "nodes", "ST-0009.json"), "{ not json")
  const l = load(dir)
  expect(l.problems.map((p) => p.file.endsWith("ST-0009.json"))).toEqual([true])
  expect(nextId(l.snapshot, "ST")).toBe("ST-0010")
  expect(code(() => write(dir, [{ tool: "add-state", params: { text: "a receipt is shown" } }]))).toBe("ok")
  expect(load(dir).snapshot.nodes.has("ST-0010")).toBe(true)
})

const cli = (cwd: string, ...args: Array<string>) => {
  const p = Bun.spawnSync(["bun", join(import.meta.dir, "../src/cli.ts"), ...args], { cwd })
  return { code: p.exitCode, out: p.stdout.toString(), err: p.stderr.toString() }
}

test("cli: build a graph, then audit code tags in a git repo", () => {
  const root = mkdtempSync(join(tmpdir(), "bgraph-repo-"))
  Bun.spawnSync(["git", "init", "-q"], { cwd: root })
  expect(cli(root, "op", "add-persona", '{"name":"Shopper","kind":"human","text":"Buys things on the website."}').code).toBe(0)
  const add = cli(root, "op", "add-scenario", JSON.stringify({ title: "Shopper pays", when: "the shopper pays", by: ["Shopper"], arrives: { text: "the cart is shown" }, then: [{ text: "a receipt is shown" }] }))
  expect(add.out.trim()).toBe("created S-0001; new states ST-0001, ST-0002")
  expect(cli(root, "op", "add-state", '{"text":"the cart is shown"}')).toMatchObject({ code: 1, err: "add-state: ST-0001 already has this text; use it\n" })
  expect(cli(root, "check").out.trim()).toBe("no findings")

  let audit = cli(root, "audit")
  expect(audit.code).toBe(1)
  expect(audit.out).toContain("code          S-0001 untagged: Shopper pays")
  writeFileSync(join(root, "pay.ts"), "// @scenario S-0001\n// @scenario S-0042\n")
  audit = cli(root, "audit")
  expect(audit.out).toContain("code          S-0042 orphan: pay.ts:2")
  expect(audit.out).not.toContain("untagged")
  writeFileSync(join(root, "pay.ts"), "// @scenario S-0001\n")
  audit = cli(root, "audit")
  expect(audit.code).toBe(0)
  expect(cli(root, "audit", "--strict").code).toBe(1)
})

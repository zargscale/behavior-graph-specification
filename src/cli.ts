#!/usr/bin/env bun
/** bgraph: manage a behavior graph stored as `<graph>/nodes/<id>.json`. */
import { readFileSync } from "node:fs"
import { parseArgs } from "node:util"
import { agenda, suggest } from "./agenda.ts"
import { audit, DEFAULT_IGNORE, exitCode, scanTags, summary } from "./audit.ts"
import { type Draft, dryRun } from "./draft.ts"
import { query, resolve } from "./entities.ts"
import { revision } from "./hash.ts"
import { OPS } from "./ops.ts"
import { render } from "./render.ts"
import { planStories, STRATEGIES, type Strategy } from "./stories.ts"
import { GraphError, load, write } from "./store.ts"
import { checkAll } from "./validate.ts"

const HELP = `bgraph — manage a behavior graph (Behavior Graph Specification 0.2)

Usage: bgraph [--graph DIR] [--json] <command> [args]

Reading
  render [ID...]              Scenarios as Gherkin-style text (focus on IDs; an intent ID shows the intent)
  check                       Structure and lint findings over the whole graph; exits 1 on errors
  agenda [--suggest]          Open questions (--suggest: failure-case candidates)
  stories [STRATEGY]          Story walks: ${STRATEGIES.join(", ")} (default journey); --focus ID, repeatable
  get REF                     Entity for a ref, e.g. gherkin/scenario:S-0002 (versioned refs say if stale)
  query TYPE                  Entities of a type; --where key=json, --text TEXT, --limit N
  revision ID...              Node revisions, for --expect

Changing
  ops                         List the operations a draft may use
  op TOOL [JSON]              Apply one operation, e.g. op add-journey '{"name":"Checkout"}'
  dry-run FILE|-              Check a draft (a JSON list of {tool, params}) without writing
  apply FILE|-                Apply a draft if it passes; --expect ID=REVISION, repeatable

CI
  audit                       Structure, lints, completeness, coverage and code tags; exits 1 on problems
                              --root DIR (git repo to scan, default .), --ignore PATH (repeatable, default docs),
                              --no-code (skip tags), --strict (completeness and coverage fail too)

The graph directory defaults to $BGRAPH_DIR, else .behavior-graph.`

const { values: o, positionals } = parseArgs({
  allowPositionals: true,
  options: {
    graph: { type: "string" },
    json: { type: "boolean", default: false },
    suggest: { type: "boolean", default: false },
    focus: { type: "string", multiple: true },
    where: { type: "string", multiple: true },
    text: { type: "string" },
    limit: { type: "string" },
    expect: { type: "string", multiple: true },
    root: { type: "string" },
    ignore: { type: "string", multiple: true },
    "no-code": { type: "boolean", default: false },
    strict: { type: "boolean", default: false },
    help: { type: "boolean", short: "h", default: false },
  },
})

const dir = o.graph ?? process.env.BGRAPH_DIR ?? ".behavior-graph"
const [command, ...args] = positionals
const print = (v: unknown, text?: string) => console.log(o.json || text === undefined ? (typeof v === "string" ? v : JSON.stringify(v, null, 2)) : text)
const die = (message: string, code = 2): never => {
  console.error(message)
  process.exit(code)
}
const readJson = async (file: string | undefined): Promise<unknown> => {
  if (file === undefined) return die("expected a file, or - for stdin")
  const raw = file === "-" ? await Bun.stdin.text() : readFileSync(file, "utf8")
  try {
    return JSON.parse(raw)
  } catch (e) {
    return die(`${file}: not JSON: ${(e as Error).message}`)
  }
}
const loaded = () => {
  const l = load(dir)
  for (const p of l.problems) console.error(`warning: ${p.file}: ${p.message}`)
  return l
}
const commitDraft = (draft: Draft) => {
  const expect = Object.fromEntries((o.expect ?? []).map((e) => e.split("=") as [string, string]))
  try {
    const w = write(dir, draft, expect)
    for (const f of w.warnings) console.error(`warn ${f.code}: ${f.message}`)
    print({ messages: w.messages, added: w.diff.added.map((n) => n.id), changed: w.diff.changed.map((c) => c.id), removed: w.diff.removed.map((n) => n.id) }, w.messages.join("\n"))
  } catch (e) {
    if (!(e instanceof GraphError)) throw e
    if (o.json) print({ error: e.code, message: e.message, about: e.about, problems: e.problems })
    else console.error(e.problems.length > 0 ? e.problems.join("\n") : e.message)
    process.exit(1)
  }
}

if (o.help || command === undefined || command === "help") {
  console.log(HELP)
  process.exit(0)
}

switch (command) {
  case "render": {
    print(render(loaded().snapshot, args.length > 0 ? new Set(args) : undefined))
    break
  }
  case "check": {
    const l = loaded()
    const findings = checkAll(l.snapshot)
    print(findings, findings.map((f) => `${f.severity.padEnd(5)} ${f.code}: ${f.message}`).join("\n") || "no findings")
    if (l.problems.length > 0 || findings.some((f) => f.severity === "error")) process.exit(1)
    break
  }
  case "agenda": {
    const items = (o.suggest ? suggest : agenda)(loaded().snapshot)
    print(items, items.map((i) => `${i.priority} ${i.id}\n  ${i.title}\n  ${i.detail}`).join("\n") || "nothing open")
    break
  }
  case "stories": {
    const strategy = (args[0] ?? "journey") as Strategy
    if (!STRATEGIES.includes(strategy)) die(`strategy must be one of ${STRATEGIES.join(", ")}`)
    const r = planStories(loaded().snapshot, strategy, o.focus === undefined ? undefined : new Set(o.focus))
    print(r, [...r.stories.map((s) => s.join(" → ")), `${r.stories.length} stories · ${r.unreachable} unreachable`].join("\n"))
    break
  }
  case "get": {
    const snap = loaded().snapshot
    const results = args.map((ref) => ({ ref, ...resolve(snap, ref) }))
    print(results.length === 1 ? results[0] : results)
    const stale = results.filter((r) => "entity" in r && r.ref.includes("@") && !r.ref.endsWith(`@${r.entity.version}`))
    for (const r of stale) console.error(`stale: ${r.ref} is now ${"entity" in r ? r.entity.ref : ""}`)
    if (results.some((r) => "failure" in r)) process.exit(1)
    break
  }
  case "query": {
    const type = args[0] ?? die("query takes a type, e.g. gherkin/scenario")
    const where = Object.fromEntries((o.where ?? []).map((w) => {
      const [k, ...v] = w.split("=")
      const raw = v.join("=")
      try {
        return [k, JSON.parse(raw)]
      } catch {
        return [k, raw]
      }
    }))
    const es = query(loaded().snapshot, { type, where, ...(o.text !== undefined ? { text: o.text } : {}), ...(o.limit !== undefined ? { limit: Number(o.limit) } : {}) })
    print(es, es.map((e) => `${e.ref}  ${e.label.text}`).join("\n") || "none")
    break
  }
  case "revision": {
    const snap = loaded().snapshot
    const revs = Object.fromEntries(args.map((id) => { const n = snap.nodes.get(id); return [id, n === undefined ? "absent" : revision(n)] }))
    print(revs, Object.entries(revs).map(([id, r]) => `${id}=${r}`).join("\n"))
    break
  }
  case "ops": {
    print(OPS.map((op) => ({ name: op.name, description: op.description })), OPS.map((op) => `${op.name.padEnd(16)} ${op.description}`).join("\n"))
    break
  }
  case "op": {
    const tool = args[0] ?? die("op takes an operation name; see bgraph ops")
    let params: unknown = {}
    try {
      params = args[1] === undefined ? {} : JSON.parse(args[1])
    } catch (e) {
      die(`params: not JSON: ${(e as Error).message}`)
    }
    commitDraft([{ tool, params }])
    break
  }
  case "dry-run": {
    const draft = await readJson(args[0])
    if (!Array.isArray(draft)) die("a draft is a JSON list of {tool, params}")
    const r = dryRun(loaded().snapshot, draft as Draft)
    print(r, [
      r.ok ? "ok" : "not ok",
      ...r.problems.map((p) => `problem: ${p}`),
      ...r.warnings.map((w) => `warn ${w.code}: ${w.message}`),
      ...r.messages.map((m) => `  ${m}`),
      `touched: ${r.touched.join(", ") || "nothing"}`,
      `affected scenarios: ${r.scenarios.join(", ") || "none"}`,
    ].join("\n"))
    if (!r.ok) process.exit(1)
    break
  }
  case "apply": {
    const draft = await readJson(args[0])
    if (!Array.isArray(draft)) die("a draft is a JSON list of {tool, params}")
    commitDraft(draft as Draft)
    break
  }
  case "audit": {
    const l = loaded()
    const root = o.root ?? "."
    const tags = o["no-code"] ? undefined : scanTags(root, o.ignore ?? [...DEFAULT_IGNORE, ...(dir.startsWith("/") ? [] : [dir])])
    const r = audit({ snapshot: l.snapshot, invalid: l.problems, strict: o.strict, ...(tags !== undefined ? { tags } : {}) })
    print(r, summary(r))
    process.exit(exitCode(r))
  }
  default:
    die(`unknown command ${command}\n\n${HELP}`)
}

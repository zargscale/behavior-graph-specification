#!/usr/bin/env bun
/** bgraph: manage a behavior graph stored as `<graph>/nodes/<id>.json`. */
import { existsSync, readFileSync, writeFileSync } from "node:fs"
import { join, relative } from "node:path"
import { parseArgs } from "node:util"
import { agenda, suggest } from "./agenda.ts"
import { audit, exitCode, scanTags, summary } from "./audit.ts"
import { CONFIG_FILE, DEFAULTS, loadConfig } from "./config.ts"
import { type Draft, dryRun } from "./draft.ts"
import { query, resolve } from "./entities.ts"
import { revision } from "./hash.ts"
import { OPS } from "./ops.ts"
import { render } from "./render.ts"
import { acceptSources, discover, keepCopies, type RecordStep, recordSteps, sourceStatus } from "./sources.ts"
import { planStories, STRATEGIES, type Strategy } from "./stories.ts"
import { GraphError, load, write } from "./store.ts"
import { checkAll } from "./validate.ts"

const HELP = `bgraph — manage a behavior graph (Behavior Graph Specification 0.3)

Usage: bgraph [--root DIR] [--graph DIR] [--json] <command> [args]

Setup
  init                        Write ${CONFIG_FILE} and a BEHAVIOR.md entry document, when absent

Sources
  sources                     Entry documents, the sources they list, and whether each changed since evaluated
  sources --accept PATH...    Record documents as evaluated now (keeps a copy for the next diff)
  sources --accept-all        Record every new or changed document

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
                              With --accept PATH (repeatable), dry-run and apply also record those source
                              documents as evaluated, in the same write, so the draft can link from them

CI
  audit                       Structure, lints, completeness, coverage, sources and code tags; exits 1 on problems
                              --ignore PATH (repeatable), --no-code (skip tags),
                              --strict (completeness, coverage and sources fail too)

Configuration comes from the nearest ${CONFIG_FILE} at or above the working directory (or --root):
  { "graph": "${DEFAULTS.graph}", "entries": ${JSON.stringify(DEFAULTS.entries)}, "ignore": ${JSON.stringify(DEFAULTS.ignore)} }
Its directory is the project root; paths in it are relative to that root. --graph and $BGRAPH_DIR override graph.`

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
    accept: { type: "string", multiple: true },
    "accept-all": { type: "boolean", default: false },
    strict: { type: "boolean", default: false },
    help: { type: "boolean", short: "h", default: false },
  },
})

let config
try {
  config = loadConfig(o.root ?? process.cwd())
} catch (e) {
  console.error((e as Error).message)
  process.exit(2)
}
const root = config.root
const dir = o.graph ?? process.env.BGRAPH_DIR ?? join(root, config.graph)
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
/** With --accept, the documents are recorded as evaluated in the same write as the draft. */
const accepted = (): ReadonlyArray<RecordStep> => {
  if (o.accept === undefined) return []
  try {
    return recordSteps(load(dir).snapshot, root, dir, discover(root, config.entries), o.accept)
  } catch (e) {
    return die((e as Error).message, 1)
  }
}
const commitDraft = (draft: Draft) => {
  const expect = Object.fromEntries((o.expect ?? []).map((e) => e.split("=") as [string, string]))
  try {
    const steps = accepted()
    const w = write(dir, [...steps, ...draft], expect)
    keepCopies(root, dir, steps)
    for (const f of w.warnings) console.error(`warn ${f.code}: ${f.message}`)
    print({ messages: w.messages, added: w.diff.added.map((n) => n.id), changed: w.diff.changed.map((c) => c.id), removed: w.diff.removed.map((n) => n.id) }, w.messages.join("\n"))
  } catch (e) {
    if (!(e instanceof GraphError)) throw e
    if (o.json) print({ error: e.code, message: e.message, about: e.about, problems: e.problems })
    else console.error(e.problems.length > 0 ? e.problems.join("\n") : e.message)
    process.exit(1)
  }
}

const ENTRY_TEMPLATE = `---
# Documents this entry sources into the behavior graph: paths or globs, relative to this file.
sources:
  - INTENT.md
---
# Behavior sources

Instructions for the agent that evaluates these documents into the graph:
what each document is authoritative for, and what to ignore.
`

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
    const r = dryRun(loaded().snapshot, [...accepted(), ...(draft as Draft)])
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
    const graphRel = relative(root, dir)
    const tags = o["no-code"] ? undefined : scanTags(root, o.ignore ?? [...config.ignore, ...(graphRel.startsWith("..") ? [] : [graphRel])])
    const d = discover(root, config.entries)
    const sources = d.entries.length === 0 && !hasSources(l.snapshot) ? undefined : { status: sourceStatus(l.snapshot, root, dir, d), problems: d.problems }
    const r = audit({ snapshot: l.snapshot, invalid: l.problems, strict: o.strict, ...(tags !== undefined ? { tags } : {}), ...(sources !== undefined ? { sources } : {}) })
    print(r, summary(r))
    process.exit(exitCode(r))
  }
  case "sources": {
    const l = loaded()
    const d = discover(root, config.entries)
    for (const p of d.problems) console.error(`warning: ${p.path}: ${p.message}`)
    if (o.accept !== undefined || o["accept-all"]) {
      const paths = o["accept-all"] ? sourceStatus(l.snapshot, root, dir, d).filter((s) => s.state === "new" || s.state === "changed").map((s) => s.path) : [...(o.accept ?? []), ...args]
      if (paths.length === 0) {
        print({ messages: [] }, "nothing to accept")
        break
      }
      try {
        const w = acceptSources(l.snapshot, root, dir, d, paths)
        print({ messages: w.messages }, w.messages.join("\n"))
      } catch (e) {
        die(e instanceof GraphError && e.problems.length > 0 ? e.problems.join("\n") : (e as Error).message, 1)
      }
      break
    }
    const status = sourceStatus(l.snapshot, root, dir, d)
    print({ entries: d.entries, sources: status, problems: d.problems }, status.length === 0
      ? `no entry documents match ${config.entries.join(", ")}; run bgraph init or set entries in ${CONFIG_FILE}`
      : status.map((s) => [
          `${s.state.padEnd(9)} ${s.path}${s.entry ? " (entry)" : ""}${s.node !== undefined ? `  # ${s.node}` : ""}`,
          ...(s.state === "changed" && s.previous !== undefined ? [`          was ${s.previous}`] : []),
          ...(s.derived.length > 0 && s.state !== "current" ? [`          derived ${s.derived.join(", ")}`] : []),
        ].join("\n")).join("\n"))
    if (status.some((s) => s.state !== "current")) process.exit(1)
    break
  }
  case "init": {
    const made: Array<string> = []
    const configFile = join(o.root ?? process.cwd(), CONFIG_FILE)
    if (!existsSync(configFile)) {
      writeFileSync(configFile, `${JSON.stringify({ graph: DEFAULTS.graph, entries: ["BEHAVIOR.md"], ignore: DEFAULTS.ignore }, null, 2)}\n`)
      made.push(CONFIG_FILE)
    }
    const entry = join(o.root ?? process.cwd(), "BEHAVIOR.md")
    if (!existsSync(entry)) {
      writeFileSync(entry, ENTRY_TEMPLATE)
      made.push("BEHAVIOR.md")
    }
    print({ created: made }, made.length > 0 ? `created ${made.join(", ")}` : "nothing to do: both exist")
    break
  }
  default:
    die(`unknown command ${command}\n\n${HELP}`)
}

function hasSources(snap: { readonly nodes: ReadonlyMap<string, { readonly type: string }> }) {
  return [...snap.nodes.values()].some((n) => n.type === "gherkin/source")
}

/** Traceability (§12.1) and a whole-graph audit for CI: structure, lints, completeness, coverage, code tags. */
import { byType, danglingEdges, type Snapshot } from "./graph.ts"
import { agenda } from "./agenda.ts"
import { JOURNEY, OUTCOME, SCENARIO, SERVES, text, nameOf } from "./model.ts"
import { checkAll, errors } from "./validate.ts"
import type { Problem as LoadProblem } from "./store.ts"

export interface Tag {
  readonly id: string
  readonly file: string
  readonly line: number
}

const MARK = "@" + "scenario"
const TAG_RE = new RegExp(`${MARK}((?:\\s+[A-Z]+-\\d+)+)`, "g")
/** Searched by default never: docs quote tags as examples. */
export const DEFAULT_IGNORE: ReadonlyArray<string> = ["docs"]

/** `git grep -n` output as tags, one per id: `path\0line\0text` (with -z) or `path:line:text`. */
export const parseTags = (grep: string): Array<Tag> =>
  grep.split("\n").flatMap((l) => {
    const m = /^([^\0]*)\0(\d+)\0(.*)$/.exec(l) ?? /^(.*?):(\d+):(.*)$/.exec(l)
    if (m === null) return []
    return [...m[3]!.matchAll(TAG_RE)].flatMap((t) => t[1]!.trim().split(/\s+/).map((id) => ({ id, file: m[1]!, line: Number(m[2]) })))
  })

/** Every tag in the git repo at `root`: tracked and untracked files, not ignored ones, not under `ignore`. */
export const scanTags = (root: string, ignore: ReadonlyArray<string> = DEFAULT_IGNORE): Array<Tag> => {
  const p = Bun.spawnSync(["git", "grep", "-z", "-n", "--untracked", "-E", `${MARK}([[:space:]]+[A-Z]+-[0-9]+)+`, "--", ".", ...ignore.map((d) => `:!${d}`)], { cwd: root })
  // git grep exits 1 when nothing matches.
  if (p.exitCode > 1) throw new Error(`git grep in ${root}: ${p.stderr.toString().trim()}`)
  return parseTags(p.stdout.toString())
}

export type CheckName = "structure" | "lints" | "completeness" | "coverage" | "code"
export type Level = "problem" | "warning"
export interface Item {
  readonly id: string
  readonly detail: string
}
export interface Check {
  readonly name: CheckName
  readonly level: Level
  readonly items: ReadonlyArray<Item>
}
export interface ScenarioStatus {
  readonly id: string
  readonly title: string
  readonly status: "built" | "planned"
  readonly tags: ReadonlyArray<{ readonly file: string; readonly line: number }>
}
export interface Report {
  readonly scenarios: ReadonlyArray<ScenarioStatus>
  readonly checks: ReadonlyArray<Check>
}

const STRUCTURE = new Set(["unknown-type", "unknown-edge", "edge-source", "edge-target", "missing-target", "too-few-edges", "too-many-edges", "duplicate-edge", "invalid-props"])
const COVERAGE = new Set(["gherkin:uncovered", "gherkin:unserving"])

export interface AuditInput {
  readonly snapshot: Snapshot
  /** Code tags; omit to skip the code check. */
  readonly tags?: ReadonlyArray<Tag>
  /** Files that failed to load. */
  readonly invalid?: ReadonlyArray<LoadProblem>
  /** Completeness and coverage fail the audit too. */
  readonly strict?: boolean
}

export const audit = (i: AuditInput): Report => {
  const snap = i.snapshot
  const tags = i.tags ?? []
  const scenarios = byType(snap, SCENARIO).map((c): ScenarioStatus => ({
    id: c.id,
    title: String(c.props.title ?? ""),
    status: c.props.planned === true ? "planned" : "built",
    tags: tags.filter((t) => t.id === c.id).map((t) => ({ file: t.file, line: t.line })),
  }))
  const findings = errors(checkAll(snap))
  const finding = (f: (typeof findings)[number]): Item => ({ id: f.about[0] ?? f.code, detail: `${f.code}: ${f.message}` })
  // Planned scenarios do not count against completeness, nor do states only they use.
  const planned = (id: string) => snap.nodes.get(id)?.props.planned === true
  const onlyPlanned = (id: string) => {
    if (planned(id)) return true
    const users = [...snap.nodes.values()].filter((n) => n.type === SCENARIO && n.edges.some((e) => e.to === id))
    return users.length > 0 && users.every((n) => planned(n.id))
  }
  const outcomes = byType(snap, OUTCOME)
  const served = new Set(byType(snap, JOURNEY).flatMap((j) => j.edges.filter((e) => e.type === SERVES).map((e) => e.to)))
  const known = new Set(scenarios.map((s) => s.id))
  const soft: Level = i.strict === true ? "problem" : "warning"
  const checks: ReadonlyArray<Check> = [
    {
      name: "structure",
      level: "problem",
      items: [
        ...(i.invalid ?? []).map((x) => ({ id: x.file, detail: x.message })),
        ...findings.filter((f) => STRUCTURE.has(f.code) && f.code !== "missing-target").map(finding),
        ...danglingEdges(snap).map((d) => ({ id: d.from, detail: `${d.edge.type} to missing ${d.edge.to}` })),
      ],
    },
    { name: "lints", level: "problem", items: findings.filter((f) => !STRUCTURE.has(f.code)).map(finding) },
    {
      name: "completeness",
      level: soft,
      items: agenda(snap).filter((a) => !COVERAGE.has(a.id) && !(a.about.length > 0 && a.about.every(onlyPlanned))).map((a) => ({ id: a.about[0] ?? a.id, detail: a.title })),
    },
    {
      name: "coverage",
      level: soft,
      items: [
        ...outcomes.filter((o) => !served.has(o.id)).map((o) => ({ id: o.id, detail: `uncovered: ${text(o)}` })),
        ...(outcomes.length === 0 ? [] : byType(snap, JOURNEY).filter((j) => !j.edges.some((e) => e.type === SERVES)).map((j) => ({ id: j.id, detail: `unserving: ${nameOf(j)}` }))),
      ],
    },
    {
      name: "code",
      level: "problem",
      items:
        i.tags === undefined
          ? []
          : [
              ...scenarios.flatMap((s): ReadonlyArray<Item> =>
                s.status === "built" && s.tags.length === 0 ? [{ id: s.id, detail: `untagged: ${s.title}` }]
                : s.status === "planned" && s.tags.length > 0 ? [{ id: s.id, detail: `planned-but-tagged: ${s.tags.map((t) => `${t.file}:${t.line}`).join(", ")}` }]
                : [],
              ),
              ...tags.filter((t) => !known.has(t.id)).map((t) => ({ id: t.id, detail: `orphan: ${t.file}:${t.line}` })),
            ],
    },
  ]
  return { scenarios, checks }
}

export const exitCode = (r: Report): 0 | 1 => (r.checks.some((c) => c.level === "problem" && c.items.length > 0) ? 1 : 0)

/** One line per item, problems first, then the counts. */
export const summary = (r: Report): string => {
  const ordered = [...r.checks].sort((a, b) => (a.level === b.level ? 0 : a.level === "problem" ? -1 : 1))
  const counts = (l: Level) => r.checks.filter((c) => c.level === l).map((c) => `${c.name} ${c.items.length}`)
  const built = r.scenarios.filter((s) => s.status === "built")
  return [
    ...ordered.flatMap((c) => c.items.map((it) => `${c.name.padEnd(13)} ${it.id} ${it.detail}`)),
    [
      `${counts("problem").join(" · ")} (problems)`,
      ...(counts("warning").length > 0 ? [`${counts("warning").join(" · ")} (warnings)`] : []),
      `${built.filter((s) => s.tags.length > 0).length} of ${built.length} built tagged, ${r.scenarios.length - built.length} planned`,
    ].join(" · "),
  ].join("\n")
}

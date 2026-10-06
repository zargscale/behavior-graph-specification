/** Source documents (§10): entry documents found by glob, the sources each lists, checksums, and their status. */
import { createHash } from "node:crypto"
import { copyFileSync, existsSync, mkdirSync, readFileSync } from "node:fs"
import { dirname, extname, isAbsolute, join, normalize, relative } from "node:path"
import { inbound, type Snapshot } from "./graph.ts"
import { FROM, findSource, sources as sourceNodes } from "./model.ts"
import type { Draft } from "./draft.ts"
import { type Expect, write, type Written } from "./store.ts"

export interface Entry {
  /** Root-relative, with forward slashes. */
  readonly path: string
  readonly sources: ReadonlyArray<string>
}

export interface Discovered {
  readonly entries: ReadonlyArray<Entry>
  /** Globs that matched nothing, unreadable frontmatter, paths outside the root. */
  readonly problems: ReadonlyArray<{ readonly path: string; readonly message: string }>
}

const posix = (p: string) => p.split("\\").join("/")
/** Never searched: dot directories (the graph, .git) and dependencies. */
const skipped = (p: string) => p.split("/").some((seg) => seg === "node_modules" || seg.startsWith("."))

const glob = (root: string, pattern: string): ReadonlyArray<string> =>
  [...new Bun.Glob(pattern).scanSync({ cwd: root, onlyFiles: true, dot: false })].map(posix).filter((p) => !skipped(p)).sort()

/** The frontmatter between leading `---` lines, parsed as YAML; undefined when the file has none. */
export const frontmatter = (text: string): Record<string, unknown> | undefined => {
  const m = /^---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/.exec(text)
  if (m === null) return undefined
  const v = Bun.YAML.parse(m[1]!)
  if (v === null || typeof v !== "object" || Array.isArray(v)) throw new Error("frontmatter is not a map")
  return v as Record<string, unknown>
}

/** Entry documents matching `patterns`, each with the sources its frontmatter lists (globs relative to the entry). */
export const discover = (root: string, patterns: ReadonlyArray<string>): Discovered => {
  const problems: Array<{ path: string; message: string }> = []
  const paths = [...new Set(patterns.flatMap((p) => glob(root, p)))].sort()
  const entries = paths.map((path): Entry => {
    let fm: Record<string, unknown> | undefined
    try {
      fm = frontmatter(readFileSync(join(root, path), "utf8"))
    } catch (e) {
      problems.push({ path, message: `frontmatter: ${(e as Error).message}` })
      return { path, sources: [] }
    }
    const listed = fm?.sources ?? []
    if (!Array.isArray(listed) || !listed.every((s) => typeof s === "string")) {
      problems.push({ path, message: "sources must be a list of paths or globs" })
      return { path, sources: [] }
    }
    const dir = posix(dirname(path))
    const found = listed.flatMap((pattern) => {
      const rel = posix(normalize(join(dir, pattern)))
      if (isAbsolute(pattern) || rel.startsWith("../")) {
        problems.push({ path, message: `${pattern} is outside the project` })
        return []
      }
      const hits = glob(root, rel)
      if (hits.length === 0) problems.push({ path, message: `${pattern} matches no file` })
      return hits
    })
    return { path, sources: [...new Set(found)].filter((s) => s !== path).sort() }
  })
  return { entries, problems }
}

/** A document's checksum: the first 12 hex digits of SHA-256 over its text with LF line endings. */
export const hashText = (text: string): string => createHash("sha256").update(text.replace(/\r\n/g, "\n")).digest("hex").slice(0, 12)

export type SourceState = "current" | "changed" | "new" | "missing" | "unlisted"

export interface SourceStatus {
  readonly path: string
  readonly entry: boolean
  readonly state: SourceState
  /** The hash of the file now; absent when the file is missing. */
  readonly hash?: string
  /** The hash last evaluated; absent when new. */
  readonly recorded?: string
  readonly node?: string
  /** The copy of the text last evaluated, for a diff. */
  readonly previous?: string
  /** Entry documents that list it (itself, for an entry). */
  readonly entries: ReadonlyArray<string>
  /** Nodes that derive from it (from edges). */
  readonly derived: ReadonlyArray<string>
}

/** Where the evaluated copy of a document at `hash` is kept. */
export const copyPath = (graphDir: string, path: string, hash: string) => join(graphDir, "sources", `${hash}${extname(path) || ".md"}`)

/** Every tracked document (entries, their sources, recorded sources) against the hashes the graph recorded. */
export const sourceStatus = (snap: Snapshot, root: string, graphDir: string, d: Discovered): ReadonlyArray<SourceStatus> => {
  const listedBy = new Map<string, Set<string>>()
  const isEntry = new Set(d.entries.map((e) => e.path))
  for (const e of d.entries) for (const p of [e.path, ...e.sources]) listedBy.set(p, (listedBy.get(p) ?? new Set()).add(e.path))
  const paths = [...new Set([...listedBy.keys(), ...sourceNodes(snap).map((n) => String(n.props.path))])].sort()
  return paths.map((path): SourceStatus => {
    const node = findSource(snap, path)
    const file = join(root, path)
    const hash = existsSync(file) ? hashText(readFileSync(file, "utf8")) : undefined
    const recorded = node === undefined ? undefined : String(node.props.hash)
    const previous = recorded === undefined ? undefined : copyPath(graphDir, path, recorded)
    const listed = listedBy.has(path)
    const state: SourceState = hash === undefined ? "missing" : !listed ? "unlisted" : recorded === undefined ? "new" : recorded === hash ? "current" : "changed"
    return {
      path,
      entry: isEntry.has(path),
      state,
      ...(hash !== undefined ? { hash } : {}),
      ...(recorded !== undefined ? { recorded } : {}),
      ...(node !== undefined ? { node: node.id } : {}),
      ...(previous !== undefined && existsSync(previous) ? { previous: posix(relative(root, previous)) } : {}),
      entries: [...(listedBy.get(path) ?? [])].sort(),
      derived: node === undefined ? [] : inbound(snap, node.id, FROM).map((e) => e.from).sort(),
    }
  })
}

export type RecordStep = { readonly tool: "record-source"; readonly params: { readonly path: string; readonly hash: string; readonly entry?: true } }

/**
 * The operations recording `paths` as evaluated as they are now. Prepend them to a draft so that the draft can link
 * `from` a new document, and the document counts as evaluated exactly when the draft applies.
 */
export const recordSteps = (snap: Snapshot, root: string, graphDir: string, d: Discovered, paths: ReadonlyArray<string>): ReadonlyArray<RecordStep> => {
  const status = new Map(sourceStatus(snap, root, graphDir, d).map((s) => [s.path, s]))
  return paths.map((p) => {
    const s = status.get(posix(p))
    if (s === undefined || s.hash === undefined) throw new Error(`${p} is not a listed source or entry document`)
    if (s.state === "unlisted") throw new Error(`${p} is no longer listed by any entry document`)
    return { tool: "record-source", params: { path: s.path, hash: s.hash, ...(s.entry ? { entry: true as const } : {}) } }
  })
}

/** Keeps a copy of each recorded text, for the next diff. Call after the steps were written. */
export const keepCopies = (root: string, graphDir: string, steps: ReadonlyArray<RecordStep>) => {
  for (const step of steps) {
    const copy = copyPath(graphDir, step.params.path, step.params.hash)
    mkdirSync(dirname(copy), { recursive: true })
    copyFileSync(join(root, step.params.path), copy)
  }
}

/** Records `paths` as evaluated, with or without a draft that came from them. Only listed documents can be accepted. */
export const acceptSources = (snap: Snapshot, root: string, graphDir: string, d: Discovered, paths: ReadonlyArray<string>, draft: Draft = [], expect: Expect = {}): Written => {
  const steps = recordSteps(snap, root, graphDir, d, paths)
  const written = write(graphDir, [...steps, ...draft], expect)
  keepCopies(root, graphDir, steps)
  return written
}

/** bgraph.json: where the graph lives, which Markdown files are entry documents, and what the tag audit skips. */
import { existsSync, readFileSync } from "node:fs"
import { dirname, join, resolve } from "node:path"

export interface Config {
  /** The directory paths are relative to: where bgraph.json is, else the working directory. */
  readonly root: string
  /** The graph directory, relative to root. */
  readonly graph: string
  /** Globs of entry documents, relative to root. */
  readonly entries: ReadonlyArray<string>
  /** Paths the code-tag audit never searches, relative to root. */
  readonly ignore: ReadonlyArray<string>
  /** The config file, when one was found. */
  readonly file?: string
}

export const CONFIG_FILE = "bgraph.json"
export const DEFAULTS = { graph: ".behavior-graph", entries: ["**/BEHAVIOR.md"], ignore: ["docs"] } as const

const strings = (v: unknown, key: string, file: string): ReadonlyArray<string> | undefined => {
  if (v === undefined) return undefined
  if (Array.isArray(v) && v.every((x) => typeof x === "string")) return v
  throw new Error(`${file}: ${key} must be a list of strings`)
}

/** The nearest bgraph.json at or above `from`, or the defaults rooted at `from`. */
export const loadConfig = (from: string = process.cwd()): Config => {
  let dir = resolve(from)
  for (;;) {
    const file = join(dir, CONFIG_FILE)
    if (existsSync(file)) {
      let raw: Record<string, unknown>
      try {
        raw = JSON.parse(readFileSync(file, "utf8"))
      } catch (e) {
        throw new Error(`${file}: not JSON: ${(e as Error).message}`)
      }
      if (raw.graph !== undefined && typeof raw.graph !== "string") throw new Error(`${file}: graph must be a string`)
      return {
        root: dir,
        graph: (raw.graph as string | undefined) ?? DEFAULTS.graph,
        entries: strings(raw.entries, "entries", file) ?? DEFAULTS.entries,
        ignore: strings(raw.ignore, "ignore", file) ?? DEFAULTS.ignore,
        file,
      }
    }
    const up = dirname(dir)
    if (up === dir) return { root: resolve(from), ...DEFAULTS }
    dir = up
  }
}

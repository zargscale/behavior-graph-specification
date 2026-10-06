/** Fingerprints (§14): node revisions detect stale edits, versions detect stale feedback and evidence. */
import { createHash } from "node:crypto"
import { canonical, canonicalJson, type Node } from "./graph.ts"

/** A node's revision: the first 12 hex digits of SHA-256 over its canonical file content. */
export const revision = (node: Node): string => createHash("sha256").update(canonical(node)).digest("hex").slice(0, 12)

/** cyrb53: stable and fast, not collision-resistant. Detects accidental change, not tampering. */
const cyrb53 = (s: string): string => {
  let h1 = 0xdeadbeef
  let h2 = 0x41c6ce57
  for (let i = 0; i < s.length; i++) {
    const c = s.charCodeAt(i)
    h1 = Math.imul(h1 ^ c, 2654435761)
    h2 = Math.imul(h2 ^ c, 1597334677)
  }
  h1 = Math.imul(h1 ^ (h1 >>> 16), 2246822507) ^ Math.imul(h2 ^ (h2 >>> 13), 3266489909)
  h2 = Math.imul(h2 ^ (h2 >>> 16), 2246822507) ^ Math.imul(h1 ^ (h1 >>> 13), 3266489909)
  return (4294967296 * (2097151 & h2) + (h1 >>> 0)).toString(16).padStart(14, "0")
}

/** A version: 12 hex digits over the canonical JSON of `v`. */
export const versionOf = (v: unknown): string => cyrb53(canonicalJson(v)).slice(-12)

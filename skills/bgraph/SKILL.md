---
name: bgraph
description: Use when a project has a bgraph.json, BEHAVIOR.md entry documents, or a behavior graph (.behavior-graph/), or when asked to turn intent, requirements or user stories documents into scenarios, sync the behavior graph with changed source documents, add or edit scenarios, states, personas, journeys or intents, or fix a failing bgraph audit. Evaluates human-written Markdown sources into the graph with the bgraph CLI, under the Behavior Graph Specification.
---

# bgraph: source documents into a behavior graph

A behavior graph describes a product as small Given/When/Then scenarios that share states. People write the *source documents* (INTENT.md, REQUIREMENTS.md, user stories). You derive the graph from them, keep it traceable to them, and re-evaluate it when they change.

The specification is the README of the `behavior-graph` repository. Section numbers below (§) refer to it.

## Ground rules

- **Never edit a source document or an entry document.** They are the people's. When a document is unclear, incomplete or contradicts the graph, add a question (`ask-question`) instead of guessing.
- **Every change goes through `bgraph`.** Never hand-edit `nodes/*.json`. Preview with `bgraph dry-run`, then `bgraph apply`.
- **Show the person the draft's effect before applying it,** and get a yes. Removing nodes always needs explicit confirmation.
- **A document counts as evaluated only together with its draft.** Pass `--accept <path>` to `apply`, which records it in the same write. Use `bgraph sources --accept` alone only when you confirmed nothing needs to change.
- **Derived nodes carry provenance:** a `from` edge to the document, with the heading as `section`.
- Do not invent behavior the documents do not state: no screens, fields, limits or error cases they do not mention. Put them on the agenda as questions.

## Setup

`bgraph` must be on the PATH. If it is not, clone the repository and run `bun install && bun link` in it. In a project without configuration, run `bgraph init`: it writes `bgraph.json` and a `BEHAVIOR.md` entry document for the person to fill in.

`bgraph.json` (at the project root) says where the graph lives and which Markdown files are entry documents:

```json
{ "graph": ".behavior-graph", "entries": ["**/BEHAVIOR.md"], "ignore": ["docs"] }
```

An entry document lists its sources in frontmatter (paths or globs, relative to it). Its body tells you how to read them. Treat those instructions as part of your task.

```markdown
---
sources:
  - INTENT.md
  - docs/stories/*.md
---
INTENT.md is authoritative for outcomes and constraints. Stories describe scenarios.
```

## The evaluation loop (§10.5)

### 1. Orient

```sh
bgraph sources            # what is new, changed, unlisted or missing; exits 1 if anything is
bgraph check              # structural errors and lint findings; fix errors first
bgraph agenda             # open questions already on record
```

Use `--json` when you need fields: `bgraph sources --json` gives each document's `state`, `entries` (which entry documents list it), `previous` (the evaluated copy) and `derived` (nodes that came from it).

If everything is `current`, there is nothing to evaluate. Stop and say so.

### 2. Read, per document that is not current

1. Read every entry document that lists it, for the instructions.
2. Read the document. For a `changed` one, also diff it against the evaluated copy: `diff -u <previous> <path>`.
3. Read what it already produced: `bgraph render <derived ids...>`, and `bgraph render <intent id>` for intents.
4. Read neighboring scenarios you may reuse states from: `bgraph render` (whole graph) when it is small, else `bgraph query gherkin/state --text <word>`.

### 3. Draft

Write a JSON list of operations to a scratch file. `bgraph ops` lists them all. The common ones:

```json
[
  { "tool": "add-intent", "params": { "title": "Self-service sign-up", "problem": "Visitors wait a day for support to create accounts." } },
  { "tool": "add-outcome", "params": { "intent": "I-0001", "text": "A visitor creates an account without contacting support." } },
  { "tool": "add-persona", "params": { "name": "Visitor", "kind": "human", "text": "A person signing up on the website. Sees forms, messages and emails." } },
  { "tool": "add-scenario", "params": {
      "title": "Visitor creates an account",
      "when": "the visitor submits valid registration details",
      "by": ["Visitor"],
      "arrives": { "text": "the registration form is shown" },
      "then": [{ "text": "the account is ready" }, { "text": "a confirmation email is sent" }] } },
  { "tool": "link", "params": { "edge": "from", "node": "S-0001", "source": "INTENT.md", "section": "Goals" } },
  { "tool": "ask-question", "params": { "intent": "I-0001", "text": "Does an unconfirmed account expire?" } }
]
```

IDs are allocated in order, so a later operation can name a node an earlier one creates. Run `bgraph dry-run` once to see the `created …` messages, then use those IDs.

A `from` link needs the document recorded as a source. For a `new` document, that happens in the same write when you pass `--accept`, below.

What to derive from what:

| In the document | In the graph |
| --- | --- |
| Why it exists, for whom | `add-intent` (title ≤ 10 words, `problem`), `link {edge: "for", intent, persona}` |
| Goals, success criteria | `add-outcome` (one sentence, ≤ 20 words) |
| Rules that must always hold | `add-constraint`, `link {edge: "bounds", constraint, journey or scenario}` |
| Undecided or contradictory points | `ask-question` |
| Actors | `add-persona` (name ≤ 4 words; text: who they are, how they reach the product, what they see) |
| Activities | `add-journey`, then `link {edge: "in"}` per scenario, and `link {edge: "serves", journey, outcome}` |
| Steps and behaviors | `add-scenario`, one per action and case |

Authoring rules the tools enforce or warn about (§5):

- **Atomic clauses.** A state or `when` has at most 15 words, states one fact or one action, and never contains `if`. `and` and `or` warn: split the facts into separate states, the cases into separate scenarios.
- **One case per scenario.** Success and failure are separate scenarios with the same arrival state. Never put alternative outcomes in one `then` list: every `then` holds together.
- **Reuse states.** Refer to existing states by `{ "id" }`, or by exactly the same `{ "text" }` (case and a trailing period do not matter). Flow between scenarios comes only from shared states: a scenario continues another when its arrival is one of the other's outcome states.
- **External behavior only.** What an actor can observe, not classes or packages.
- **Mark unbuilt behavior `planned`:** `edit-scenario {id, planned: true}`.
- Mark starting states `entry: true` and endpoints `terminal: true` (`edit-state`), so the agenda does not ask about them.

For a **changed** document, prefer editing over adding: reword a state with `edit-state` (every scenario using it updates), change a scenario with `edit-scenario`, relink with `link`/`unlink`. Text removed from the document means its derived nodes may need to go. Propose `unlink`/`remove` operations, and apply them only with the person's yes.

For an **unlisted** or **missing** document, ask the person whether its derived nodes stay (then `unlink {edge: "from", node, source}`) or go. After that, `bgraph op remove '{"id":"SRC-…"}'` removes the source.

### 4. Preview and confirm

```sh
bgraph dry-run draft.json --accept INTENT.md --accept BEHAVIOR.md
```

Pass `--accept` for every document this draft evaluates, entry documents included. Fix every `problem:` line and dry-run again. Then show the person:

- the operations in plain words;
- the affected scenarios as text: `bgraph render <affected ids>` (for new ones, describe them from the draft);
- the warnings, and any questions you added.

Apply only after they agree:

```sh
bgraph apply draft.json --accept INTENT.md --accept BEHAVIOR.md
```

This applies the draft and records the documents as evaluated, with a copy of their text for the next diff, in one write.

If `apply` reports a stale node, someone changed the graph meanwhile. Reread the graph and redo the draft. Never force it.

### 5. Record and report

```sh
bgraph sources --accept docs/glossary.md   # only for documents you evaluated that needed no change
bgraph sources                             # should now be all current
bgraph agenda                              # what is still open
```

Report what changed, what you asked, and what is still open. If the project has CI, `bgraph audit` must pass; `bgraph audit --strict` also requires every document to be current and the agenda's completeness and coverage questions to be resolved.

## Other tasks

- **Edit the graph directly** (no source document involved): same draft → dry-run → confirm → apply cycle. If a source document covers the behavior, the document wins. Tell the person the document needs the change instead.
- **Failing `bgraph audit`:** `structure` and `lints` are graph errors to fix through operations. `code` lists untagged built scenarios and orphan `// @scenario` tags in code. `sources` lists documents to evaluate. `completeness` and `coverage` are agenda questions.
- **Traceability in code:** implementation and tests carry `// @scenario S-0002` (several IDs allowed). A scenario without code is `planned`.

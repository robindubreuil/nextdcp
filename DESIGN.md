# nextdcp — design

Architecture and rationale; the README documents installation, options, and
user-visible behavior. Design priorities, in order: reliability across models,
simplicity (KISS), prompt-cache friendliness, and low cost.

## Core idea

> **Do not rebuild compaction. Make OpenCode's native compaction lossless and
> episodic, and give the model one tool to recall anything.**

OpenCode V2 already handles the hard, fragile parts: trigger thresholds, overflow
retries, choosing the cut at a user-turn boundary, rendering the checkpoint,
auto-continue, revert, and UI events. Its weaknesses are:

1. A single *rolling* summary that gets rewritten at every compaction, so it drifts
   and loses detail ("summary of summary").
2. No retrieval of what was dropped.
3. No pruning in V2, so stale tool outputs keep piling up until a costly compaction.

nextdcp fixes exactly these three things, using official hooks only:

```
 request = [system] [checkpoint: working state + recent tail] [messages since checkpoint, raw]
                          ▲
        compaction hook (archive first, then summarize = the only elision)
 archive (ctx.storage)  ◄── raw rows and tool calls saved at each compaction
 recall tool  ──► archive + live history
```

## Working set, not a diary

The visible checkpoint is one replacement working state: objective, standing
user constraints, relevant verified state, unfinished work, and at most three
archive references. One compactor request also writes a short cold archive note.
Completed work does not earn permanent context space because it shares a topic.
The archive retains full original rows/tool calls; no topic graph, embeddings,
background observer, automatic per-turn retrieval, or merge generation is needed.

The rendered handoff ends with one compact **archive anchor** line — the episode
count, the first and last episode titles, and the covered time span at adaptive
precision, then `Browse: recall catalog; search: recall(query)`. It is the only
always-on archive context: a fixed, self-explanatory pointer that says the archive
exists, roughly when it covers, and how to open it. The catalog is fetched on
demand: a compact line per episode, one page per call, with one episode's whole
note or the full-note view one request away.

The normal working-state ceiling is 2,000 estimated tokens for the complete
rendered handoff, with a prompt target of about 1,000 or less. The estimate is
chars/4 — with Han, kana and hangul characters counting as roughly one token
each — not a provider-tokenizer guarantee, and does not include native retained
tail, system instructions, tool definitions, or subsequent conversation.
The existing soft/hard triggers are unchanged.

## Round-scoped deferral

Some tasks legitimately need many large results live at once. The `defer_compaction`
tool lets the model propose skipping the budget trigger for the
current round only. Three gates apply in order: physics (the conversation
must fit 80% of the model's window; an unknown window is refused, so no approval is
spent on a context that would overflow anyway), user consent (the host permission
system, action `defer_compaction`, default ask with native Always allow, shown with
the model's reason), and idempotence within the round. A grant never disables
recovery: a compaction already in flight still runs. The grant expires when its
round ends — success, failure or interruption — and that round writes no deferred
idle marker; without re-affirmation, the next round's mid-turn budget trigger
catches up in one bounded compaction. One in-memory decision per session, never
inherited or persisted.

## Commit and failure contract

1. Archive the new cut first, independently recording individual recall gaps.
2. Read the checkpoint's prior structured state and snapshot the model policy.
3. Generate one schema-validated JSON handoff using prior state and the complete
   new cut. Main-model generation preserves native history/media; separate-model
   generation uses readable originals and safe-capacity checks, visibly falling
   back to the main model for unsupported inputs/errors. Never truncate a cut.
4. Carry forward standing constraints omitted by the model. Retirement requires
   the exact old constraint plus a new user row ID and verbatim quote from it.
   Keep task-local requirements in state/next, not the permanent constraint list.
   Persist retirement evidence with the checkpoint for audit.
5. Validate references against the reachable archive and count the entire rendered
   state. The archive note must begin with a `Title:` line and stay in the language
   of the user's messages — a compactor may not introduce a writing system the user
   never used. An invalid/oversized/off-language handoff gets at most one repair
   attempt, and every retry carries the exact validation failure so the stronger
   model repairs the defect instead of repeating it. Network or essential-storage
   failures do not trigger speculative repair requests.
6. Save the structured state and cold archive note before returning version-2
   metadata. Never truncate active constraints. A custom result must fit its
   budget; when the final repair is still over, commit the shortest valid
   handoff, disclosed by a warning — a structured, constraint-preserving
   artifact beats native's unbounded summary plus raw tail at any size. Native
   compaction stays in control only when no valid handoff was produced, or when
   saving fails. A native fallback can exceed this budget and is an explicit
   exception, not bounded success.

Existing episode archives remain unchanged and recallable. Old checkpoints
are migrated on their next compaction, not eagerly rewritten. Forks/reverts select
the corresponding structured state; historical fork reconstruction renders exactly
that checkpoint, preserving its summary and independent originals/media.

## Components

### One elision boundary (`session.hook("compaction")`)

Earlier versions elided stale tool outputs mid-request ("observation masking",
the SWE-agent "garbage collection"). It was removed: a stub in the request is
quiet — the model cannot tell it from content, recovery re-reads the stub
instead of the original, and every commit rewrote the request prefix. Elision
now happens in exactly one place: the compaction summary that replaces the
archived cut, next to the capture-time archive that stores raw rows and tool
calls. The conversation runs raw through the round; whatever the summary omits
is one `recall` hop away.

### Episodic archive (`session.hook("compaction")`)

When a compaction fires (native trigger, or the deferred / hard-budget triggers):

1. **Cut:** let native compaction choose it. No `keepID` override.
2. **Archive first, before any generation:** store the new cut's persisted rows and
   its completed parent checkpoint from `ctx.session.context` (rows have DB ids;
   provider-format tool messages in `event.messages` do not) as compact JSON text
   in `ctx.storage`, keyed by row id. Do not rewrite older immutable history:
   cumulative archive-row writes grow linearly across compactions. Store tool
   inputs and outputs in full and index them by call id. Process items
   independently: log
   failures and conflicting call ids, keep the first original, continue with the
   rest, and mark the episode with a recall gap if anything was missed.
3. **One handoff request** produces the replacement working state and the short
   cold archive note together, covering all messages after the previous checkpoint
   row — including the tail native compaction will keep. The boundaries are then
   unambiguous ("everything after the checkpoint"), so no message has to be quoted
   to mark them. The tail appears both in this episode and verbatim in the new
   checkpoint's recent context; the next episode starts after the new checkpoint
   row, so episodes never overlap and never leave gaps. Episode notes are fixed and
   dense: a `Title:` line, task and outcome, exact paths/symbols/error strings and
   search terms. The rendered episode header takes its title from that line.
   Main-model generation goes through `ctx.session.generate` with full native
   history plus an instruction, preserving native projection and cache behavior.
   A separate compaction model uses `ctx.experimental.generate.text` with the
   prior working state and the complete readable new-cut transcript, including
   original tool text; it omits hidden reasoning and provider metadata and never
   silently truncates. Unsupported content, unavailable models, unsafe capacity,
   empty responses and request errors warn and fall back to the main model.
4. **Return** `event.result = { summary: render(working state), metadata: { nextdcp: { version: 2 } } }`.
   Native compaction wraps this in `<conversation-checkpoint>`.
5. **If episode generation or essential checkpoint storage fails, leave `result`
   unset.** Native compaction runs as usual. Individual archive failures do not
   block the episode: they produce an explicit recall gap instead. Losslessness is
   guaranteed only when the relevant archive writes succeed.

The episode chain is keyed by compaction-row id (each record points to its parent
checkpoint). Rendering follows the chain from the *current* checkpoint, so reverts
and undos are handled for free. Each episode records a `start`/`end` span from its
rows' `time.created` — one pair per episode, never per turn — used only to render
time in the catalog and the anchor line. **Native checkpoint without `nextdcp`
metadata**
(after a fallback, a fork, or lost storage): adopt its native summary text as one
episode (`Ek — (native summary)` in the catalog) and continue the chain from it.

`/compact-model` is a TUI-only picker backed by a portable, schema-validated
`nextdcp.model` RPC. Its keymap layer is global so slash autocomplete and the
command palette can discover it in their own input modes; the command itself
is enabled only on a session route. Policies are `default` (honor
`agents.compaction.model`), `main`, or a specific provider/model/variant. Persist
them under `sessions/<id>/model`, outside the checkpoint chain; reloads preserve
them, reverts do not change them, and forks do not copy them. Read the policy
once before summary generation. Saving a policy validates the live text-model
catalog but generates nothing. No new tool or LLM command is exposed. Warnings
are persisted, logged and emitted to TUI clients; event subscriptions retry
across reloads. The main model is never set.

Keep `experimental.background_compaction` disabled (the default): a precomputed
native summary can be applied without rerunning the plugin hook, so a recall gap
is possible. If a provider-native checkpoint has no textual summary, leave it
under native control rather than replacing it with an empty episode. Episode
resolution and archive search may then be unavailable on that chain; an already
archived tool call can still be retrieved directly by id.

### `recall` tool (the only tool and the only prompt surface)

```
recall({ query?: string, id?: string, layer?: string, page?: number })
```

Two calls, one grammar. `query` searches the archive; `id` is a **target
address** — the same lean string the system renders everywhere, so any address
the model sees is copy-paste runnable:

```
recall E57                   an episode, conversation layer (default)
recall E57 layer tools page 2  an episode's tool output, page 2
recall call_01HZ2a3          one exact tool call
recall catalog               the episode catalog, newest first (one line per episode)
recall catalog all           every episode's archive note
recall catalog E7            one episode's archive note
```

An address is a handle (`E57`, `call_01HZ2a3`, `catalog`) plus optional
`layer <conversation|tools|full>` and `page <n>` pairs; `catalog` instead takes
an optional view — `all`, or one exact entry label (`E7`). Listings return one
page per call and continue at `page <n>`; a single entry note fetches whole like
any original.
The same `layer` and `page` also work as direct parameters — for a query they set
the search depth and result page, for an id they fill in what the address omits,
and the address wins where both set one.

#### Layers: the depth within a chapter

An episode is a chapter; `layer` selects the depth to read or search. The default
is **`conversation` everywhere** — for fetching an episode and for searching — so
there is exactly one rule to remember. Raise the depth only when the question
needs it.

| `layer` | `recall {id:"E57", layer}` | `recall {query, layer}` |
|---|---|---|
| **conversation** *(default)* | dialogue + tags for tool/shell commands, activated skills and attached text (name + head, no bodies) | search that conversation text |
| **tools** | full calls + shell output + injected skill/attachment text, from the `calls/` and row originals | search that non-dialogue content only |
| **full** | everything interleaved (the raw conversation) | search everything |

`full` is the raw transcript. `conversation` is what was *said and asked*; `tools`
is what the tools *returned*. That separation is the point: "why did we decide X"
is a `conversation` question, "what was the exact error" is a `tools` question, and
a broad probe is `full`. Tool output renders from the `calls/` original, the
canonical archive record. Tool tags in
the conversation layer render the call target as `recall call_01HZ2a3`, so any
output is one hop away. A tag identifies a call, it does not carry it: a heavy
input (a hand-rolled script written live, a long heredoc) reduces to its first
200 characters plus the omitted count — the whole input stays in the call
original, one hop away, and script-content search lands on that `tools` home
instead of cluttering the dialogue. The same rule covers injected content: an
activated skill or an inline text attachment renders as a tag (name plus
character count) pointing at its row original, which is that text's one home —
injected bodies never ride the dialogue. Hidden reasoning is stored but not rendered in any layer
yet; it joins the matrix later.

#### The catalog: the only summary surface

`recall catalog` returns the episode list — id, title, time span, and the cold
archive note — **newest first**, the whole thing in one call up to 30,000
characters. Episode notes are labels, not content: they live here and nowhere else
except as labeled `archive note` hits in unfiltered `full` search (the cheap "which
episode was about X" probe). There is no summary *layer* to reach for a single note
— triage is the catalog's job.

#### Addresses and IDs

Every rendered target — tool-call tags, search hits, page labels —
reads `recall <address>`. IDs abbreviate to their unique 12-character prefix
(`call_01HZ2a3` for `call_01HZ2a3b4c5…`), and recall resolves any unambiguous
prefix git-style: an exact ID wins, a unique prefix resolves, an ambiguous one
errors listing its candidates. Full IDs keep working, so nothing stored breaks and
old addresses stay valid.

#### Time: one rule, three surfaces

*A span renders at the unit its own elapsed time justifies; a stamp renders only
the fields its reference can't already imply; a standalone fetch re-anchors at full
precision.*

- **Span unit-matching:** elapsed < 1 day → times; ≥ 1 day → days (times dropped);
  ≥ 1 year → years — plus a compact duration at that scale (`14h 32m`, `32d`,
  `2y 3mo`).
- **Stamp cascade:** `14:30` → `11-03 14:30` → `2027-01-02 09:12` — each stamp omits
  what the surrounding rendering already states; the date-day is atomic. Episode
  times come from rows' `time.created`, recorded once per episode as `start`/`end`.

The archive anchor line and the catalog use this ladder, so they stay one line and
one screen at any session length.

#### Search corpus: one home per fact

Every fact is indexed in exactly one place. Conversation documents carry only
tags; each `calls/` original is its own document; each shell row and each
skill/attachment-bearing user or skill row is its own document. A query therefore hits
*the fact itself*, and hit lines render runnable
targets (`recall call_01HZ2a3`, `recall E57 page 2`). `layer` filters which homes a
search covers; archive-note hits surface only in unfiltered `full` search. A recall
result's own output is marked an echo and excluded from ranking, so a
re-presentation of evidence never competes with the original it quotes. Immutable
transcripts and originals are cached in memory (bounded LRU), and the assembled
corpus is cached per checkpoint: a warm query rescans nothing, and the next
compaction — the only mutation that can change it — rebuilds it fresh.

#### Content and privacy

Media stays native: return text plus file content parts on the page containing each
attachment label, without JSON/base64 expansion. Decode inline text attachments so
they are searchable; their home is the row original, and the conversation layer
carries only their tag. Archived rows stay complete in compact JSON, but every
rendering and its search index show readable user, assistant, tool, shell, synthetic
and checkpoint text — never row ids, timestamps, costs, provider metadata,
signatures, or hidden reasoning. Tool output is not clipped.

The tool description is the *entire* protocol the model needs to know. There is
nothing in the system prompt, no message-ID tags, no nudges, no reminders and no
priority labels — with one exception: the budget-gate notice, a single system part
sent only when the raw conversation crosses the compaction budget mid-round,
because it must reach the model before its next step, not after it asks. Recall
results are ordinary tool outputs; the single compaction elision boundary keeps the
system bounded.

### Keeping context low (two compaction triggers)

The aim is a context that stays small all the time, without asking the model to
manage it. Native compaction triggers at window − 15%, which is far too late for
cost and quality (context rot), so the plugin adds two triggers of its own:

- **Deferred soft trigger (the main one; option `idle`).** The end of a successful
  turn is a natural "topic finished" boundary, but not proof that the conversation
  will continue. Subscribe to `session.execution.succeeded` and, if at least
  `idle` tokens (default 25k) of new conversation have accumulated since the last
  checkpoint, persist only `{ checkpoint, after, tokens }`, where `after` is the
  last history-row id. No model call runs while the user is away. On the next
  `session.hook("prompt")`, validate that the current checkpoint and last row
  still match, then await compaction **admission**, not summary generation, before
  allowing OpenCode to admit the new prompt. Native steered compaction runs before
  pending prompts, so the new message stays verbatim after the checkpoint. The
  queued message's text (trimmed, capped at 2,000 characters) is added to the
  generation data as `queued`: a relevance signal for what stays live and which
  references matter — evidence, never instructions — and it cannot retire
  constraints because retirement requires an exact quote tied to a real user row
  ID. Opening a session alone does nothing. The marker survives plugin/service
  reloads, is not inherited by forks, and does not apply to a staged revert or
  child session. Missing/corrupt storage or rejected admission must not block the
  prompt; the hard budget and native overflow remain safety nets. Growth is
  measured from the actual context request rather than a duplicate
  row-to-message projection, and a measurement is usable only for its checkpoint.
  Failed, interrupted and transient executions do not mark compaction due;
  measuring growth avoids loops on the retained tail. The tradeoff is resume
  latency and possibly a colder provider prompt cache; avoiding a summary for an
  abandoned conversation takes priority.
- **Hard budget (within a turn).** In the context hook, estimate conversation
  tokens with chars/4, excluding system instructions and tool definitions, and
  calibrate the estimate toward real tokens against provider-reported usage from
  recent completed requests (native chars/4 units apply until a usable pair of
  usage-bearing rows exists). Above `budget` (default `min(50% window, 100k)`),
  compact when growth since the checkpoint is at least `min(idle, budget / 4)`.
  Native overflow handling still accounts for the complete request.
- Both triggers share one per-session admission guard. The context hook is
  fire-and-forget; concurrent prompt hooks share and await the admission promise
  so none race ahead of the compaction control. Errors are caught. The guard
  clears on `session.compaction.ended`, `session.compaction.failed`, rejected
  admission, the next successful execution with no running compaction, or after
  three minutes. After `session.compaction.failed`, new requests are blocked for
  three minutes so a persistent failure cannot cause a retry on every step. The
  event subscriber retries if its stream ends unexpectedly; model windows are
  cached by provider and model. On `session.deleted`, the session's storage keys
  (including the deferred marker) and in-memory state are removed.
- **Cost reasoning:** with caching, every step pays cache-read price × context
  size, so a smaller steady-state context is a direct saving. Rewrites happen
  only at compactions. A completed
  conversation does not pay for a speculative final summary. Byte stability
  holds *between* compactions; each compaction invalidates the cache from its
  first change onward.

### Possible later

- A `/memory` command (list episodes, stats) and a TUI panel through RPC.
- A per-checkpoint memo of the token accounting: `messageTokens` runs on every
  context event at live sizes (~1,900 rows). Fine at current sizes; cache per
  checkpoint if sessions grow.
- A guard in `formatRow`: it parses its raw JSON unguarded, so a corrupt stored
  row surfaces a raw `SyntaxError` instead of the transcript path's clean
  `[Invalid archived row]` degradation. Cosmetic — plugin-written rows are
  valid JSON — but worth tidying.
- None of this is needed for the core.

## Focused retrieval and deployment

BM25 ranks bounded transcript passages and short archive notes, not whole long
documents. Excerpts choose the densest relevant window, retain their source ID
and raw-text page, and deduplicate identical evidence. Notes are explicitly labeled
as summaries. Search returns four excerpts per page, at most 40 ranked results;
opening an original returns the whole original in one call up to 30,000 characters,
or 6,000-character pages for larger ones, with native files only on the part
containing their label. Retrieved originals stay live once recalled; pagination
preserves Unicode surrogate pairs.
Only archived/hidden data is indexed; visible history is not redundantly retrieved.

Local production installs use content-addressed, never-overwritten release copies.
Build/test output is separate from the live plugin path. The release script tests
first and prints a URI; it never edits host configuration. Activation is an explicit
URI change after private-server validation, with the old release kept for rollback.

This favors measured task success and total task cost, not token minimization at
the expense of correctness. A 100-checkpoint synthetic test checks boundedness,
and real-model checks cover task replacement, constraints, recall, model selection,
reloads, native fallback paths, triggers, queues and forks/media. These do not prove
universal summary fidelity or dollar savings; matched coding-workload benchmarks
remain necessary. Research rationale: Anthropic's context-engineering guidance,
The Complexity Trap (arXiv:2508.21433), and VibeMemBench (arXiv:2609.23570).

Known trade-off: after compaction, native compaction renders the recent tail as
**text** (reasoning dropped, tool outputs clipped to 1,250 chars). That is
acceptable because `recall` gets the full outputs back. If it proves harmful, the
compaction metadata can override the recent-context rendering.

## Tech stack

- **TypeScript**, using `@opencode/plugin` V2 (`Plugin.define`), peer range
  `>=2.2.5 <3`. Erasable syntax only (no `enum` or `namespace`) so Node can run
  the sources natively. The shipped artifacts are self-contained ESM bundles
  (server and TUI) built by a development-only esbuild; `@opencode/plugin` stays
  external and there are no runtime dependencies.
- **Storage** is `ctx.storage` (the plugin-scoped KV in opencode.db); writes are
  serialized per durable key across host contexts and hot reloads. **Search** is
  in-memory BM25, enough for MB-scale archives (FTS5 only if ever needed).
  **Tokens** are chars/4 with the CJK adjustment described above; estimates that
  face model window limits are calibrated against provider-reported usage.
- **Architecture:** a functional core with an imperative shell. Pure functions
  `planCut`, `resolveMemory`, `renderMemory`, `search`, `messageTokens`
  hold all the logic; the hooks are thin adapters.
- **Tests:** `node --test` (Node 22.18+ for native type stripping) on the pure
  core and the hook adapters.
- **Config:** a handful of keys via plugin `options`: `idle`, `budget`,
  `memory.budget`, `debug`. The size
  of the kept tail is native config (`compaction.keep.tokens`).

```
src/
  index.ts       Plugin.define entry
  runtime.ts     hooks, compaction, recall tool and trigger adapters
  tokens.ts      token estimation
  memory.ts      checkpoint chains, episodes and rendering
  working.ts     handoff schema: parsing, validation, budget
  recall.ts      transcripts, pagination and BM25
  store.ts       typed ctx.storage wrapper
  prompts.ts     working-state prompt and tool descriptions
  models.ts      compaction-model policy and safe-capacity checks
  model-rpc.ts   nextdcp.model RPC schema and state
  picker.ts      /compact-model TUI picker
  tui.ts         TUI bundle entry
test/
  support/history.ts test-only row-to-message projection
```

## Relation to opencode-dcp

nextdcp is a clean-room rewrite, not an iteration on opencode-dcp (v3.2.0,
AGPL-3.0; nextdcp is MIT). The problems observed there come from its core
design, not from bugs:

| Symptom | Root cause |
|---|---|
| Context breaks into many tiny blocks | The agent picks ranges ad hoc. Nothing ever consolidates them; nesting just copies summaries into new ones. |
| Models echo reminders, misread `@4@` tags as images, etc. | IDs are injected into user text and tool outputs, and reminders are injected into history. The model has to understand a private protocol. |
| No way to get details back | Compression is view-only; the model has no retrieval tool. Only the user can decompress. |
| Housekeeping takes the agent's attention and costs output tokens | The main (expensive) model writes every summary, prompted by nudges. |
| Fragility | About 9.6k LOC: a v1/v2 adapter, regex stripping and re-injection every turn, unpersisted ref maps, private SDK patching, and detecting internal agents by string matching. |
| Prompt-cache churn | Every compress rewrites history from its anchor onward, and nudge anchors move. |

Deliberately dropped from that design: the agent-driven `compress` tool and range
IDs, message-ID injection, nudges and reminders, manual mode, the notifications
UI, auto-update, the custom-prompt override tree, and V1 support. Model-visible
ids appear only in episode headers and `recall` output.

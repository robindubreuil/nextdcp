# nextdcp — current design (0.5.0)

## Working set, not a diary

The visible checkpoint is one replacement working state: objective, standing
user constraints, relevant verified state, unfinished work, and at most three
archive references. One compactor request also writes a short cold archive note.
Completed work does not earn permanent context space because it shares a topic.
The archive retains full original rows/tool calls; no topic graph, embeddings,
background observer, automatic per-turn retrieval, or merge generation is needed.

The normal working-state ceiling is 2,000 estimated tokens for the complete
rendered handoff, with a prompt target of about 1,000 or less. The estimate is
chars/4 — with Han, kana and hangul characters counting as roughly one token
each — not a provider-tokenizer guarantee, and does not include native retained
tail, system instructions, tool definitions, or subsequent conversation.
The existing soft/hard triggers and batched sticky observation masks are unchanged.

## Round-scoped deferral

Some tasks legitimately need many large results live at once. The `defer_compaction`
tool lets the model propose skipping the budget trigger and new mask planning for the
current round only. Three gates apply in order: physics (the unmasked conversation
must fit 80% of the model's window; an unknown window is refused, so no approval is
spent on a context that would overflow anyway), user consent (the host permission
system, action `defer_compaction`, default ask with native Always allow, shown with
the model's reason), and idempotence within the round. A grant never disables
recovery: committed masks still render, their originals stay recallable, and a
compaction already in flight still runs. The grant expires when its round ends —
success, failure or interruption — and that round writes no deferred idle marker;
without re-affirmation, the next round's mid-turn budget trigger catches up in one
bounded compaction. One in-memory decision per session, never inherited or persisted.

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
   state. An invalid/oversized handoff gets at most one repair attempt. Network or
   essential-storage failures do not trigger speculative repair requests.
6. Save the structured state and cold archive note before returning version-2
   metadata. Never truncate active constraints or save an over-budget custom result.
   If this fails, warn and leave native compaction in control. A native fallback
   can exceed this budget and is an explicit exception, not bounded success.

Existing episode archives remain unchanged and recallable. Old checkpoints
are migrated on their next compaction, not eagerly rewritten. Forks/reverts select
the corresponding structured state; historical fork reconstruction renders exactly
that checkpoint, preserving its summary and independent originals/media.

## Focused retrieval and deployment

BM25 ranks bounded transcript passages and short archive notes, not whole long
documents. Excerpts choose the densest relevant window, retain their source ID
and raw-text page, and deduplicate identical evidence. Notes are explicitly labeled
as summaries. Search returns four excerpts per page, at most 40 ranked results;
opening an original returns at most 6,000 characters, with native files only on
the page containing their label. Pagination preserves Unicode surrogate pairs.
Only archived/hidden data is indexed; visible history is not redundantly retrieved.

Local production installs use content-addressed, never-overwritten release copies.
Build/test output is separate from the live plugin path. The release script tests
first and prints a URI; it never edits host configuration. Activation is an explicit
URI change after private-server validation, with the old release kept for rollback.
Integration runs also freeze the adapter and plugin into their own temporary bundle.

This favors measured task success and total task cost, not token minimization at
the expense of correctness. A 100-checkpoint synthetic test checks boundedness,
and real-model checks cover task replacement, constraints, recall, model selection,
reloads, native fallback paths, triggers, queues and forks/media. These do not prove
universal summary fidelity or dollar savings; matched coding-workload benchmarks
remain necessary. Research rationale: Anthropic's context-engineering guidance,
The Complexity Trap (arXiv:2508.21433), and VibeMemBench (arXiv:2609.23570).

## Historical design notes (0.1–0.2)

The original proposal and experiment history below are retained for context.
Its episode accumulation/merge policy and 8%-window budget are superseded by the
0.5.0 contract above and the current README. They are not current behavior.

Goal: let an agent run indefinitely in a single OpenCode session, with full context retrievable on demand.
Design priorities, in order: robustness across models, simplicity (KISS), prompt-cache friendliness, and low cost.

## 1. Why not iterate on opencode-dcp (v3.2.0)

The problems observed with DCP come from its core design, not from bugs:

| Symptom | Root cause in DCP |
|---|---|
| Context breaks into many tiny blocks | The agent picks ranges ad hoc. Nothing ever consolidates them; nesting just copies summaries into new ones. |
| Models echo reminders, misread `@4@` tags as images, etc. | IDs are injected into user text and tool outputs, and reminders are injected into history. The model has to understand a private protocol. |
| No way to get details back | Compression is view-only, but the **model** has no retrieval tool. Only the user can decompress. |
| Housekeeping takes the agent's attention and costs output tokens | The main (expensive) model writes every summary, prompted by nudges. |
| Fragility | About 9.6k LOC: a v1/v2 adapter, regex stripping and re-injection every turn, unpersisted ref maps, private SDK patching, and detecting internal agents by string matching. |
| Prompt-cache churn | Every compress rewrites history from its anchor onward, and nudge anchors move. |

It is also AGPL-3.0. A clean-room rewrite can be MIT.

**Decision: start from scratch, V2 plugin API only.** OpenCode v2.2.0 is the supported host, and V1 plugins don't run on V2. DCP's V2 path is only an adapter around its V1 pipeline.

## 2. Core idea

> **Don't rebuild compaction. Make OpenCode's native compaction lossless and episodic, cut growth with deterministic masking, and give the model one tool to recall anything.**

OpenCode V2 already handles the hard, fragile parts: trigger thresholds, overflow retries, choosing the cut at a user-turn boundary, rendering the checkpoint, auto-continue, revert, and UI events. Its weaknesses are:

1. A single *rolling* summary that gets rewritten at every compaction, so it drifts and loses detail ("summary of summary").
2. No retrieval of what was dropped.
3. No pruning in V2, so stale tool outputs keep piling up until a costly compaction.

nextdcp fixes exactly these three things, using official hooks only:

```
 request = [system] [checkpoint: episodic memory + recent tail] [messages since checkpoint, stale outputs masked]
                          ▲                                                   ▲
              compaction hook (episodes)                         context/generate hooks (masking)
 archive (ctx.storage)  ◄── raw messages saved at each compaction / mask
 recall tool  ──► archive + live history
```

## 3. Components (~1k LOC target, zero runtime deps)

### 3.1 Masking (`session.hook("context")` and `session.hook("generate")`)
This is "observation masking". Research on SWE agents shows it matches LLM summarization at a fraction of the cost.
- **Candidates:** completed `tool-result` parts that:
  - are not provider-executed;
  - are not from a protected tool (`skill`, `todowrite`, `task`, …);
  - exceed `mask.minTokens` (default 400);
  - sit more than `mask.distance` tokens (default 20k) from the end of the request. Distance is measured in tokens, not turns, because autonomous runs can have one user turn and hundreds of steps.
- **Large tool-call inputs** (e.g. `write`/`edit` file contents) beyond the same distance: replace string fields longer than `mask.minTokens` with the same kind of stub. Keep the input a valid object with the same keys. The full input stays recallable by call id.
- **Rendering:** `result = {type:"text", value:'[Output elided to save context: ~3.1k tokens. Retrieve with recall {"id":"toolu_…"}]'}`. The adjacent call already shows the input. Leave an output unmasked if its notice would save nothing. The part, id and name are kept, so tool-call pairing stays valid. Reasoning parts and `providerExecuted` parts are never touched.
- **Sticky and batched:** masks are stored under the active checkpoint id (or `root`) and cached per session. The set only grows within that checkpoint; a revert selects the old key. A new plan normally saves at least `mask.batch` tokens (default 10k). If an individual call cannot be archived, skip it and commit the other successfully archived calls, even if the remaining savings are below the batch threshold. Between commits the rendered prefix is byte-identical.
- **Optional rule ("superseded"):** mask an earlier `read` of a file once that file has been read again, edited or written later.
- The same pure function runs in the `generate` hook, so summary generation reuses the primary request's cache prefix.

### 3.2 Episodic memory (`session.hook("compaction")`)
When a compaction fires (native trigger, or our deferred / hard-budget triggers in 3.4):
1. **Cut:** let native compaction choose it (`compaction.keep.tokens`). No `keepID` override.
2. **Archive first, in its own try block, before any generation:** store the new cut's persisted rows and its completed parent checkpoint from `ctx.session.context` (rows have DB ids; provider-format tool messages in `event.messages` do not) as compact JSON text in `ctx.storage`, keyed by row id. Do not rewrite older immutable history: cumulative archive-row writes grow linearly across compactions. Store tool inputs and outputs in full and index them by call id. Masked outputs are also archived when their mask batch is committed. Process items independently: log failures and conflicting call ids, keep the first original, continue with the rest, and mark the episode with a recall gap if anything was missed.
3. **Summarize one new episode** covering *all* messages after the previous checkpoint row, including the tail native compaction will keep. The boundaries are then unambiguous ("everything after the checkpoint"), so no message has to be quoted to mark them. The tail appears both in this episode and verbatim in the new checkpoint's recent-context; the next episode starts after the new checkpoint row, so episodes never overlap and never leave gaps.
   - With the main-model policy (or no configured override), call `ctx.session.generate` with full native history plus an instruction. This preserves native projection/cache behavior; committed masks are stubs. For a selected/configured compaction model, use public `ctx.experimental.generate.text` with earlier memory and the complete readable new-episode transcript, including original tool text. It omits hidden reasoning/provider metadata, never silently truncates, and can be larger than the masked view. Attachments, unsupported row content, unavailable models, unsafe/unknown context capacity, empty responses and request errors warn and fall back to native session generation. Never mutate the session model or fabricate a temporary session.
   - The episode format is fixed and dense: title, user requests (quoted verbatim when short), actions and outcomes, decisions and their rationale, files touched, current state and next step, and open threads. The renderer takes the header title from the generated `Title:` line.
   - Earlier episodes are **never rewritten** by this step, so they don't drift.
4. **Consolidate:** when the episodes exceed `memory.budget` (default `min(8% window, 8k)` tokens), merge the oldest ones into one coarser episode (`E1-E4`) that keeps its child ids, so recall still reaches the raw data. Use `ctx.experimental.generate.text` with the same compaction-model policy and only the selected summaries. With the main-model policy, resolve the current session model, or use session generation if it is implicit. Capacity and availability checks also apply to merges; warn before falling back to `ctx.session.generate`. Log a failed, empty or non-shrinking merge and save the checkpoint with the unmerged episodes instead of falling back to native.
5. Return `event.result = { summary: render(episodes), metadata: { nextdcp: {...} } }`. Native compaction wraps this in `<conversation-checkpoint>`.
6. **If episode generation or essential checkpoint storage fails, leave `result` unset.** Native compaction runs as usual. Individual archive failures do not block the episode: they produce an explicit recall gap instead. Losslessness is guaranteed only when the relevant archive writes succeed.

The episode chain is keyed by compaction-row id (each record points to its parent checkpoint). Rendering follows the chain from the *current* checkpoint, so reverts and undos are handled for free. **Native checkpoint without `nextdcp` metadata** (after a fallback): adopt its native summary text as one episode (`Ek (native)`) and continue the chain from it.

`/compact-model` is a TUI-only picker backed by a portable, schema-validated
`nextdcp.model` RPC. Its keymap layer is global so slash autocomplete and the
command palette can discover it in their own input modes; the command itself
is enabled only on a session route. Policies are `default` (honor `agents.compaction.model`),
`main`, or a specific provider/model/variant. Persist them under
`sessions/<id>/model`, outside the checkpoint chain; reloads preserve them,
reverts do not change them, and forks do not copy them. Read the policy once
before summary generation and reuse it for that compaction's merges. Saving a
policy validates the live text-model catalog but generates nothing. No new tool
or LLM command is exposed. Warnings are persisted, logged and emitted to TUI
clients; event subscriptions retry across reloads. The main model is never set.

Keep `experimental.background_compaction` disabled (the default): a precomputed native summary can be applied without rerunning the plugin hook, so a recall gap is possible. If a provider-native checkpoint has no textual summary, leave it under native control rather than replacing it with an empty episode. Episode resolution, archive search and later custom episodes may then be unavailable on that chain; an already archived tool call can still be retrieved directly by id.

### 3.3 `recall` tool (the only tool and the only prompt surface)
```
recall({ id?: string, query?: string, page?: number })
```
- `id` is an episode (`E3`) or a tool call id from a stub. It returns the transcript or output, paginated to about 8k tokens. Merged ids use ASCII hyphens; recall also accepts en and em dashes, including for previously stored ranges.
- `query` is keyword (BM25) search over complete episode transcripts and the archived originals of elided tool data in the current context, before pagination. Every hit carries an id and the page where the matching token starts; a token spanning a page boundary remains searchable. Visible, unmasked content is not indexed because the model can already see it. Merged episodes and their individual children remain recallable. Immutable episode transcripts and their native attachments are cached in memory (bounded LRU, including inline file-URI sizes).
- Media stays native: return text plus file content parts on the page containing each attachment label, without JSON/base64 expansion in the readable transcript. Decode inline text attachments so they are searchable. Provider media support and continued availability of URI-only files remain host/model constraints.
- Forks have fresh checkpoint row IDs and separate storage. On `session.forked` (or first use after a missed event), match copied checkpoint summaries against the parent's history at the recorded fork boundary. Copy the reachable checkpoint/merge chain, original rows and calls, and relevant masks; reserve the episode counter above inherited IDs. Commit an import marker last so failed imports can retry. Imported branches need no subsequent parent access and survive parent deletion/reload; ordinary subagents are not forks. Import cannot recover data already lost from the parent.
- Archived rows stay complete in compact JSON, but transcript output and its search index render readable user, assistant, tool, shell, synthetic and checkpoint text. Tool output is not clipped; row ids, timestamps, costs, provider metadata, signatures and reasoning are omitted from this rendering.

The tool description is the *entire* protocol the model needs to know. There is nothing in the system prompt, no message-ID tags, no nudges, no reminders and no priority labels. Recall results are ordinary tool outputs and get masked again later, so the system stays bounded.

### 3.4 Keeping context low (two compaction triggers)
The aim is DCP's advantage, context that stays small all the time, without asking the model to manage it. Native compaction triggers at window − 15%, which is far too late for cost and quality (context rot), so the plugin adds two triggers of its own:
- **Deferred soft trigger (the main one; option `idle`).** The end of a successful turn is a natural "topic finished" boundary, but not proof that the conversation will continue. Subscribe to `session.execution.succeeded` (OpenCode 2.2.0 does not publish `session.status`). If at least `idle` tokens (default 25k) of new conversation have accumulated since the last checkpoint, persist only `{ checkpoint, after, tokens }`, where `after` is the last history-row id. No model call runs while the user is away. On the next `session.hook("prompt")`, validate that the current checkpoint and last row still match, then await compaction **admission**, not summary generation, before allowing OpenCode to admit the new prompt. Native steered compaction runs before pending prompts, so the new message stays verbatim after the checkpoint. Opening a session alone does nothing. The marker survives plugin/service reloads, is not inherited by forks, and does not apply to a staged revert or child session. Missing/corrupt storage or rejected admission must not block the prompt; the hard budget and native overflow remain safety nets. Growth still comes from the actual masked context request rather than a duplicate row-to-message projection, and a measurement is usable only for its checkpoint. Failed, interrupted and transient executions do not mark compaction due. Measuring growth avoids loops on the retained tail. Episodes still follow successful turn boundaries, with consolidation keeping their number bounded. The tradeoff is resume latency and possibly a colder provider prompt cache; avoiding a summary for an abandoned conversation takes priority.
- **Hard budget (within a turn).** In the context hook, estimate conversation tokens with chars/4, excluding system instructions and tool definitions. Above `budget` (default `min(50% window, 100k)`), first commit a mask batch; compact only if still above the budget and growth since the checkpoint is at least `min(idle, budget / 4)`. Native overflow handling still accounts for the complete request.
- Both triggers share one per-session admission guard. The context hook is fire-and-forget; concurrent prompt hooks share and await the admission promise so none race ahead of the compaction control. Errors are caught. The guard clears on `session.compaction.ended`, `session.compaction.failed`, rejected admission, the next successful execution with no running compaction, or after three minutes. After `session.compaction.failed`, new requests are blocked for three minutes so a persistent failure cannot cause a retry on every step. The event subscriber retries if its stream ends unexpectedly; model windows are cached by provider and model. On `session.deleted`, the session's storage keys (including the deferred marker) and in-memory state are removed.
- **Cost reasoning:** with caching, every step pays cache-read price × context size, so a smaller steady-state context is a direct saving. DCP got this by rewriting history mid-turn, which broke the cache on each prune. Here rewrites happen only at mask batches and at deferred or hard-budget compactions. A completed conversation does not pay for a speculative final summary.
- Byte stability applies *between* committed mask batches and *between* compactions, not across those rewrites. Each rewrite invalidates the cache from its first change onward. The mask batch threshold exists so that the tokens saved outweigh that one-time cost.

### 3.5 Optional, later
- A `/memory` command (list episodes, stats).
- A TUI panel through RPC.
- None of this is needed for the core.

## 4. Tech stack
- **TypeScript**, using `@opencode/plugin` V2 (`Plugin.define`), with peer range `>=2.2.0 <3`. OpenCode loads the `.ts` plugin directly. Use erasable syntax only (no `enum` or `namespace`) so Node can run the files natively. No build step; add bundling only if npm publishing requires it.
- **Zero runtime deps:**
  - storage is `ctx.storage` (the plugin-scoped KV in opencode.db; no separate files);
  - search is in-memory BM25, which is enough for MB-scale archives (FTS5 only if ever needed);
  - tokens are chars/4.
- **Architecture:** a functional core with an imperative shell. Pure functions `planMask`, `renderMask`, `planCut`, `renderMemory`, `search` hold all the logic. The hooks are thin adapters.
- **Tests:** `node --test` (Node 26 strips types natively) on the pure core, with golden fixtures captured from real sessions (a debug flag dumps `event.messages`). Plus one end-to-end smoke test against a local OpenCode server.
- **Config:** a handful of keys via plugin `options`: `idle`, `budget`, `mask.{minTokens,distance,batch,protected}`, `memory.budget`, `debug`. The size of the kept tail is native config (`compaction.keep.tokens`).

```
src/
  index.ts      Plugin.define and execution-event adapter
  runtime.ts    hooks, compaction, recall tool and trigger adapters
  mask.ts       planMask / renderMask
  memory.ts     episodes, consolidation and checkpoint chains
  recall.ts     transcripts, pagination and BM25
  store.ts      typed ctx.storage wrapper
  prompts.ts    episode + merge prompts, recall description
test/
  support/history.ts   test-only row-to-message projection for fixtures
```

## 5. Risks (all 5 passed on v2.2.0)
1. `result` together with `metadata.keepID` in the compaction hook behaves as the source suggests on v2.2.0.
2. `ctx.session.generate` called inside the compaction hook: no deadlock, and the cache-read tokens show the prefix was reused.
3. Masking in the context hook: the provider accepts the stubs, and cache hits hold between batches.
4. `ctx.storage` throughput with about 10k keys.
5. Revert across a compaction: the episode chain is resolved correctly.

**Step 3 verification** (synthetic sessions, isolated v2.2.0 server):
- Masked tool inputs and outputs, episode generation and continuation passed on a hosted model and a local model. The hosted run included signed reasoning parts and stable prefixes across mask batches.
- Native automatic compaction passed separately from the plugin's busy-context budget trigger. The latter was tested with a single 56k-character user turn.
- With the default 25k-token threshold, a successful execution spent no summary tokens while stopped or after a location reload. The next prompt triggered exactly one deferred compaction and remained verbatim after its checkpoint. A message queued during compaction ran afterward; an interrupted execution triggered nothing. The hard-budget and native automatic checks still passed independently.
- `advanceEpoch` re-baselines instruction state. In one run, the system and tool hashes stayed identical across compaction, while the first post-compaction request read 1,344 cached tokens and created 1,736. This observation alone does not establish why the cache hit was limited.

Known trade-off: after compaction, native compaction renders the recent tail as **text** (reasoning dropped, tool outputs clipped to 1,250 chars). That is acceptable because `recall` gets the full outputs back. If it proves harmful, the compaction metadata can override the recent-context rendering.

### Production hardening (0.1.1)

- Historical forks reconstruct the parent's checkpoint/tail from durable, ordered pending cuts when `session.context` no longer includes their boundary. No database or private host API is used. Locally archived calls remain recallable even if context or inheritance is unavailable.
- Soft growth starts with the actual masked request and adds only newly generated assistant output (including reasoning and completed tool results). The raw boundary and its prior output size prevent double counting, stale-branch reuse, and retry-row inflation.
- Durable-key write queues are shared across host contexts and hot-reloaded modules, not keyed by storage-wrapper identity. Native checkpoint adoption uses the same process-wide serialization.
- Ship one bundled ESM entry, with `@opencode/plugin` external and no additional runtime dependencies. `npm run build` uses development-only esbuild; `npm pack` builds automatically. Local installations point at `dist` to avoid cached package-entry resolution and stale source-module imports observed in the running 2.2.5 host. Source edits require a rebuild.
- Archive, inheritance, native-fallback and merge failures warn even without debug mode. Regression tests cover the failure modes; real-server checks include historical forks and a final-reply-only threshold crossing.

## 6. What is deliberately dropped from DCP
The agent-driven `compress` tool and range IDs, message-ID injection, nudges and reminders, manual mode, the notifications UI, auto-update, the custom-prompt override tree, and V1 support.

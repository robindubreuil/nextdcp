# nextdcp — design

Current architecture for **0.16**, targeting OpenCode V2 **2.3.2+**. The README
documents installation and options. `GATE-PLAN.md` and `PLAN-0.10.md` are historical
proposals, not the current contract.

Priorities: truthful continuity and recoverable evidence, simple state
transitions, then prompt-cache behavior and cost. A smaller request is not, by
itself, evidence of better task quality or lower total cost.

## Boundary and invariants

OpenCode owns prompt admission, the compaction boundary, transcript replacement,
the recent tail, overflow recovery, and continuation. nextdcp adds an archive,
replacement working state, on-demand recall, and advisory scheduling through
documented hooks. It does not prune or rewrite individual live tool results.

```text
request: [system/tools] [checkpoint: working state + native recent tail] [new rows]
                                  ▲
main-model build → optional checkpoint_now edit + evidence fence
                                            │
actual host cut → archive originals → validate edit OR generate → save → handoff
                       │
                       └──────────── recall on demand
```

The contract is:

1. **Archive at the actual cut, before replacement.** No speculative compactor
   request. A main-authored edit must still fit its evidence fence; otherwise the
   complete final cut is supplied to generation.
2. **Serialize a session's checkpoint pipeline.** Reuse a committed handoff on a
   repeated hook; do not generate it again or accept a changed boundary.
3. **Generate only when needed, with two shared attempt slots.** A fresh valid
   main edit uses zero. Patch, full regeneration, repair, and selected-model fallback
   do not get independent retry budgets.
4. **Preserve active constraints, disclose failures.** Compactness is a soft
   target, not permission to silently truncate instructions or conceal a recall gap.
5. **Separate capacity from growth.** Retained checkpoints, instructions, tool
   definitions, and media still consume capacity even when they are not new growth.
6. **Own asynchronous work and stored data.** Session/project ownership is explicit;
   deletion and unload close admission and drain work instead of racing a clear.
7. **Label historical provenance.** Notes are summaries, off-chain originals are
    not current-branch evidence, and recalled history is data rather than new orders.
8. **Separate admission from completion.** An accepted control is a requested cut,
   not an archive or completed working state. Diagnostics observe; they do not
   change conversation or scheduling.

### Required host configuration

Require **`compaction.background: false`**. OpenCode currently defaults it to
`true`; its held-summary preparation can run without a durable running checkpoint
and later apply that summary without another hook. Such preparation is not a
supported cut. nextdcp saves accessible originals, warns, and refuses that hook
instead of claiming to have produced a normal episode.

A later native textual checkpoint is adopted with any known recall gap disclosed.
The obsolete `experimental.background_compaction` key is not a substitute. See
the current [compaction guide](https://opencode.ai/docs/compaction) and
[server hook contract](https://opencode.ai/docs/build/plugins/server).

## Durable state and ownership

OpenCode storage is scoped to the **plugin**, not automatically to a project.
Path segments below are encoded; project keys use the session's actual
`projectID`, never a literal shared `project/` prefix.

```text
sessions/<sessionID>/
  owner                         projectID, Location, subagent flag
  rows/<rowID>                  original persisted row as compact JSON
  calls/<callID>                complete tool input/result, first original wins
  pending/<checkpointID>        parent, ordered row IDs, archive status, reserved E ID
  checkpoints/<checkpointID>    parent, episode note, author, working state or native summary
  episode-counter               monotonic E<n> allocation
  deferred-compaction           branch-specific next-prompt marker
  gate-stats                    advisory telemetry only
  model                         per-session compaction-model policy
  model/warning, model/warnings  current warning and capped timestamped history
  fork                          successful inheritance marker
projects/<projectID>/
  thermostat                    learned entries per main provider/model
  episodes/P<n>                 graduated notes with source session and end time
  episode-counter               monotonic P<n> reservation
  episodes-revision             invalidates graduated-note caches
deleted/<sessionID>              durable namespace tombstone
```

Ownership is read and saved while the session exists. `ctx.location` describes
the plugin instance, not every session it can access. Public events are global:
route by recorded event Location, including workspace ID, or resolved/persisted
session ownership. Missing ownership is not guessed, including during deletion.
Older unowned `project/*` records are neither imported into a guessed project nor
deleted automatically.

Durable-key queues are shared in-process across host contexts and hot-reloaded
modules. They serialize counters, call originals, fork imports, cuts, and the
session write fence. They are not distributed locks across independent services.

## One serialized checkpoint pipeline

### 1. Capture the actual boundary

Read `ctx.session.context` and require a running compaction row. `planCut` selects
every row after the previous completed checkpoint and before that running row;
it does not override native `keepID` or use the shorter retained-tail boundary.
The replacement therefore accounts for the final assistant reply and newly completed
tool work, including material OpenCode will also retain as recent context.

Save a pending boundary first. Archive this cut and its completed parent
checkpoint, not the whole old history again. Store full rows and index complete
or error tool results by call ID. Process individual failures independently;
conflicting calls keep the first original and mark the cut incomplete. Essential
boundary-storage failure falls back to native compaction. Partial archive failure
instead marks the episode with a recall gap.

Reserve the episode ID in the pending record. Native fallback adoption can reuse
that reservation. Failed cycles and reverted branches can still leave gaps in the
visible catalog; IDs are addresses, not a count of successful episodes.

### 2. Assemble authoritative prior state

Checkpoint records form a parent chain keyed by host compaction-row ID. Follow
only the active checkpoint's ancestry, so a revert selects the matching working
state and catalog. Previously archived branch originals are not erased by revert.

A structured prior state enables patch mode. A **native textual checkpoint
invalidates stale structured objective/state/next**: its summary is authoritative,
and the next regeneration receives it rather than patching pre-fallback state.
Still-active standing constraints travel separately across that transition.

Adoption uses the saved pending boundary when available. Without an archived cut,
the native episode explicitly reports the missing originals. An opaque provider
checkpoint with no textual summary stays under native control; episode resolution
and search may then be unavailable. Store-only call/row lookup remains independent
of a readable episode chain.

### 3. Select an author; generate only when necessary

`checkpoint_now` accepts `archive`, partial `working` fields, and optional
`retire: [{ constraint, quote }]`. Its base is the **latest canonical working state**,
including earlier main-authored edits, not a frozen compactor seed. Omitted fields
carry forward; present lists replace their predecessors. Standing constraints
remain additive/protected until explicitly retired with new-user evidence. New
entries are themselves self-contained exact quotes from actual new user text;
host rules and unchecked assistant paraphrases cannot become protected entries.
No additional model-authored provenance envelope is needed. A short cold note
accompanies each direct edit; there is no appended notes log.

Validate the merged edit before admission. Without structured prior state, require
all working fields or let `{}` request compactor seeding. `{}` always chooses
generation. No obsolete `keep` input or once-per-round slot is retained. There is
no arbitrary edit-string or total payload cap; schema/constraint/reference checks
still apply, and the complete merged state is measured against a soft size target.

Each context build captures ordered semantic row hashes: user/injected/media
evidence, assistant text/tool inputs/results/errors, structured human question
answers, shell data, and completed
checkpoint summary/tail. Timing, billing, hidden reasoning, idle markers and
noncompleted compaction controls are not evidence. Payload keys named `time` or
`tokens` inside user/tool data remain evidence, not bookkeeping.

A newly admitted edit stages its base checkpoint, fence, validated full handoff,
and ToolContext message/call IDs. At the archived cut, require the same base and
ordered evidence, excluding only the proposal's own sole `checkpoint_now`
publication. The tool must have completed successfully; another tool in its step
precludes direct use. New user prompt admission also invalidates a staged edit,
even before the user's row appears. Revalidate schema, constraints and references
at the cut. Missing observations, changed/late evidence or a changed base select
safe compactor regeneration, never a stale commit.

Only a fresh admission can stage a proposal. Concurrent duplicates cannot replace
it; rejection/timeout clears it. Uncommitted proposals and evidence hashes are
in-memory only, so reload safely regenerates. Committed working state and
`main`/`compactor` authorship are durable and reused on repeated hooks.

#### Compactor path

One response contains a cold archive note and replacement working state:

```text
archive: Title line + short searchable note about only this cut
working: objective, constraints[], state[], next[], references[at most 3]
retiredConstraints: exact old constraint + verbatim new-user evidence
```

The first attempt is a patch if the prior working state is structured, otherwise
a full handoff. Present patch fields replace whole fields; omitted fields carry
forward. The merged whole receives the same validation as full generation.

After any failure, the remaining attempt requests a complete replacement and
carries the failure text. If a selected compaction model failed, the remaining
attempt uses the main model. **There are two attempt slots for the pipeline, not
two per mode or model.** Unsupported-input and capacity refusals conservatively
consume a slot even if no provider request was sent. Native host fallback may
make its own request afterward; it is outside this plugin attempt bound.

Main-model generation uses `ctx.session.generate`, preserving native request
projection and media handling. Its checkpoint and user text are already in that
context: the prompt does not copy them again or add a user-snippet directory.
Retirement quotes resolve to durable user-row or question-call IDs in the shared validator; authors
need not copy IDs (older explicit-ID handoffs remain valid). After native fallback,
separately protected constraints are still supplied if its summary omitted them.
An explicitly selected/configured compaction
model uses `ctx.experimental.generate.text`: prior state plus the complete
readable new-cut transcript, including original tool text. It omits hidden
reasoning/provider metadata, refuses attachments or unsupported content, and
never silently truncates the cut to fit.

The selected model must be an available text model/variant with known safe input
capacity. Its estimate uses a 20% padding plus 1,024 tokens and reserves advertised
output (8,192 if absent), honoring both context and separate input limits.
Unavailable models, unsafe capacity, unsupported inputs, empty responses, and
request errors warn and fall back rather than picking an arbitrary provider.

### 4. Validate and commit

Validate the schema, reachable archive references, title, constraint retirements,
and complete rendered working-state size. Prior standing constraints omitted by
the model are carried forward, including legacy rules without source metadata.
A new constraint must itself occur verbatim in a real user row's text or a completed
built-in `question` call's structured `state.metadata.answers` in the new cut.
Only that human-answer envelope is normalized as user evidence; question input,
rendered tool prose, other tools' metadata, attachments, injected skills and queued
relevance hints cannot supply proof. Separate answers never form a joined quote.
Retirement requires an exact prior constraint and a quote from such a new human
source: explicit withdrawal or correction of a misattributed rule. These are source
checks, **not proof** of semantic intent; the author must distinguish quoted
evidence from actual standing instructions. Legacy rules are not silently erased.
Task-local requirements belong in state/next, not an ever-growing permanent list.

The author keeps only information needed for the next decision or action, an
unresolved uncertainty, or expensive rediscovery. Host/project instructions stay
in their authoritative sources. Cold notes are brief outcomes and search cues,
not a second working-state copy. Gate notices and reminders ask for normal work or direct
authorship, never a preliminary summary for a compactor that already has the data.

The prompt asks for the user's language. A limited writing-system check rejects
new CJK script in the archive note when absent from new user messages; it is not
a general language detector. The parser does not prove semantic completeness.

The normal working-state target is at most about 1,000 estimated tokens and its
soft ceiling is `memory.budget` (default 2,000). Count all rendered headings,
constraints, references, archive anchor, and gap disclosure. A working state
sets `metadata.keepID: null`, so OpenCode keeps no verbatim recent tail beside it;
system instructions, tool schemas, and later conversation are **additional**.
For a **valid main-authored edit**, exceeding this target warns and commits unchanged:
no truncation and no generation merely to shrink it. For **compactor generation**,
if neither attempt fits but a structurally valid oversized handoff exists, commit
the shortest valid candidate with a warning. Never slice constraints to meet the
budget. When no valid handoff exists, or essential checkpoint saving fails, leave
`event.result` unset and disclose native fallback as an unbounded exception.

Save the structured checkpoint and its archive note before returning
`{ summary, metadata: { nextdcp: { version: 2, author: "main" | "compactor" } } }`. OpenCode renders the checkpoint
wrapper and recent tail. A repeated hook with the same committed boundary renders
that saved handoff without another model request.

The live handoff contains current work, not an episode directory. One archive
anchor gives coverage, episode endpoints, and `recall catalog` / `recall(query)`.
Cold notes and old originals are fetched only when needed. Summaries remain lossy;
recoverability depends on successful archive writes and use of recall.

## Scheduling: capacity first, preferences second

### Three meters

- **Retained conversation (automatic mode):** the latest completed summary and
  native `metadata.recent` tail plus persisted rows after that checkpoint,
  excluding ephemeral reasoning and older archived rows. This meter schedules
  the overdue-checkpoint safeguard.
- **New durable growth:** persisted rows after the completed checkpoint. Count
  user text/skills/attachments, retained assistant text/tool data, shell output,
  and relevant injected text; exclude ephemeral reasoning and the retained
  checkpoint/tail. It schedules explicit `budget`/`idle` overrides, gives every
  admission its identity, and prevents zero-growth recompaction loops.
- **Complete request projection:** assembled hook messages, system parts, and
  serialized tool definitions, including checkpoint/tail, skills, shell, and
  media. This meter requests capacity recovery before honoring any soft hold.

Returned evidence — successful tool results except `question`/`checkpoint_now`,
plus foreground shell output — is a mechanical subset of durable growth. It
buys temporary room until it ages out and is excluded from baseline learning; it is not
a claim that every result is necessary.

Text estimates use chars/4 with Han/kana/hangul near one token per character;
media has fixed estimates. `usageScale` applies the median of up to three usable
provider-input-growth/estimated-growth ratios. Samples exclude checkpoint/model
boundaries and implausible ratios. Cache accounting and provider behavior remain
assumptions to validate against traces, not exact tokenization.

On each eligible context build, before any held-round or low-growth return:

```text
reserve = explicit hook maxTokens, else advertised output, else 8192
capacity = max(0, min(contextWindow - reserve, separateInputLimit) - 1024)
```

If the calibrated complete projection exceeds capacity and there is new growth,
clear the soft hold/gate and request compaction. Running compaction and staged
reverts are left alone. Unknown windows disable this plugin capacity check and
automatic soft budget; explicit soft thresholds still work. Native recovery is
unchanged. This is a queued recovery request, not a guarantee that every provider
request fits: fixed instructions/tool schemas, later hook/transport changes, and
estimation error can still dominate.

### Soft scheduling, guidance and the gate

Automatic mode compares the retained conversation with a **live threshold**:
the adaptive baseline plus a temporary fresh-evidence allowance. An explicit
`budget` overrides it with a new-durable-growth threshold; `false` disables soft
gates and reminders. An explicit `idle` independently overrides/disables the
next-prompt path. Neither disables manual compaction or the known-window
capacity check.

- **Fresh-evidence room:** returned evidence after the checkpoint and since the
  last successful turn end (an `idle` row whose outcome is not `interrupted` or
  `failed`) earns weight 1 for 12 assistant steps of age, then declines
  linearly to 0 at step 28. Interruptions, failures and steering continue the
  same work, so they do not reset it. Ages are per result, so later reads never
  rejuvenate older ones. `allowance = min(1.5 × weighted, capacity − requestOverhead − baseline)`,
  where overhead is the projected request minus the retained conversation, so
  instructions, schemas, output reserve and margin stay out of reach. The
  allowance applies on the very build carrying the results, clears an open gate
  that is no longer crossed (so round end cannot repay it), and is
  diagnostic-only in `/memory`.
- **Pause reminders (automatic, tail placement only, mid-round only):** a pause
  is the latest assistant step having at least 60 estimated tokens of visible
  text, following the model's own previous step rather than a user row, and
  calling tools (so the round continues) with no newer user row and no
  `question` call pending a human answer. A finished round is left to
  next-prompt scheduling, which is steered by the user's message and needs no
  extra model step. A pause is suppressed when that step's own returned
  evidence plus newer input exceeds 5% of the baseline or any of its tools
  failed — those results are unseen. A reminder also requires new durable growth
  of at least 25% of the baseline since the checkpoint and since the previous
  reminder. Independently, a complete projection at or above 85% of safe
  capacity warns once per checkpoint, with the same growth floor. Delivery
  identity is (checkpoint, assistant-step count): an identical rebuild replays
  unanswered guidance; a new step marks it delivered. A cut resets spacing.
  Reminders never queue admission, are omitted when they would not fit
  capacity, and are skipped with `notice: "system"` to avoid rewriting the
  cached prefix for optional text. Replaying this session's own 277-step history
  placed 9 reminders against 9 actual checkpoints, four of them at or within six
  steps before one; that is a sanity check, not a benchmark.
- **Mid-round crossing:** open one gate for the current round/checkpoint. Append
  a clearly automated notice at the conversation tail (provider user role), or
  a system part for `notice: "system"`. The model's next step still has raw
  context; the following build requests the actual cut. Continue is the default;
  a `checkpoint_now` edit can supply the next state without a second generation.
  Authorized delegation is an option, not an automatic operation by nextdcp. No
  compactor summary is prepared during that evaluation step. A required notice
  that would exceed capacity yields to capacity recovery.
- **No later build:** a round ending with an unheld open gate repays its crossing.
  Without a live round, an eligible crossing requests compaction silently. For
  explicit budgets only, a recent tool failure postpones the soft decision during
  diagnosis; never capacity recovery or the automatic safeguard. Guards/cooldowns
  suppress repeated admission.
- **Successful-turn scheduling:** include final retained output, then persist only
  `{ checkpoint, after, tokens, threshold }` when due, comparing the automatic
  baseline (the successful turn end has reset evidence credit) or the explicit threshold. No idle
  summary request. The next prompt hook verifies that exact branch/boundary,
  recomputes new growth for admission identity, and awaits compaction
  admission, not generation, before admitting the new message. Its first 2,000
  trimmed characters become labeled relevance evidence, not a user row or a
  basis for retiring constraints. Reopening alone does nothing.
- **`checkpoint_now`:** approval-free working-state-edit admission; refuse a staged
  revert/inactive round and report an already running/pending cut. An open gate
  is only a schedule: admit and stage the edit normally, then clear the gate on
  admission. No once-per-round restriction; a completed cut moves the boundary,
  permitting another edit. Pending/duplicate-boundary/cooldown safeguards remain.

All admission paths share one session guard. Context hooks never await the
runner's compaction; prompt hooks share its admission promise. The guard clears
on outcome/rejection, a verified successful execution without running compaction,
or a three-minute timeout. A failed cut imposes a three-minute retry cooldown.
Gate, explicit-budget spike, manual-checkpoint, and capacity counts are telemetry, not controller
inputs; reminders are visible only as the last in-memory decision. Model-window lookups are cached per provider/model.

Admission returns an explicit `requested`, `already-pending`, `not-admitted`, or
`failed` outcome. Concurrent callers share the admission result, including a
failure; guards, cooldowns and duplicate attempts are not successful new requests.
Only accepted early requests count. A refused/failed edit is not staged for a
future cut. No tool waits for the cut that needs its own step to finish.
Host outcome events, not saved/prepared handoffs, establish completion separately.

### Read-only accounting

`/memory` is a TUI dialog backed by the portable `nextdcp.memory.get({ sessionID })`
RPC. It is not another model-visible tool or a source of automatic prompt text.
It reads the session and saved metadata directly, without invoking ownership
saves, archive adoption/inheritance, scheduling hooks, model generation or writes.
The TUI resolves the session's Location and reads the current client per attempt.
Only `rpc.unavailable` is retried during cold plugin registration, with bounded,
abortable backoff. The native dialog bounds its scroll viewport to terminal height,
supports keyboard/wheel scrolling, and releases resize/focus resources on close.

Show current summary and native `metadata.recent` characters/estimated tokens,
new durable row growth, retained total, calibration and threshold scope. In
automatic mode show the live threshold, its adaptive baseline, the temporary
evidence allowance recomputed only for the same model, checkpoint and round as
the last build, and the baseline bounds. Retain only numeric counts
for the last context-hook projection: messages, system parts, serialized tool
definitions, total, output reserve, safety margin and known capacity limits.
Include this plugin's gate notice in those counts. The projection is a timestamped
observation at this hook, not a reconstruction of a future or final wire request.
Row estimates are not added again to the message total. Raw latest provider
input/cache/output/reasoning counters are a separate measurement with its source ID.

Last decision/hold and completed/failed cut reasons are small in-memory diagnostics.
Show saved checkpoint authorship when known; do not infer generation from admission.
Reload discards them and the request observation; missing values stay unavailable,
and an older checkpoint's request snapshot is labeled stale. Host checkpoint rows
can still establish a recorded outcome without inventing its trigger. No summary
text or prompt bodies are copied into diagnostic state; no extra model request,
tail tuning, or durable telemetry namespace is added.

### Adaptive baseline

Persist learned entries per **main model and actual project**, versioned so
older growth/demand budgets reseed instead of masquerading as this policy. A
committed custom handoff closes a cycle; ordinary subagents and unknown windows
do not train it. Recall frequency is not a control signal.

For context window `W`, output reserve `O` (fallback 8,192) and separate input
limit `I`:

```text
capacity = max(1, floor(min(W - O, I) - 1024))
start    = min(capacity, W / 2, 200000)
floor    = ceil(0.75 * start)          ceiling = min(capacity, floor(1.5 * start))
routine  = durable - returnedEvidence  (per committed cycle)
target   = retainedAtCycleStart + 28 * EMA(routine / assistantSteps)
next     = clamp(target, max(floor, ceil(0.8 * prev)), min(ceiling, floor(1.5 * prev)))
```

EMAs are half-weight; observed span feeds only the short-cycle diagnostic,
which refers to the upper policy bound, never physical window exhaustion. A
changed window can force an immediate clamp. Excluding returned evidence keeps
one read-heavy cycle from permanently raising the threshold for ordinary work;
such reads get temporary fresh-evidence room instead. Neither 200k, 28 steps nor the step
limits are benchmarked quality or cost optima, and the baseline is a fallback,
not a checkpoint cadence. Storage failures report and fall back to defaults.

### Explicit-budget spike hold

Only for an explicit positive `budget`: at a soft crossing in a live round, if
the last ten assistant steps' durable growth rate is at least twice the learned
rate, hold soft compaction for that round. It requires a learned rate and a
known window; **complete capacity is rechecked on every eligible build before
the hold**. A hold expires on success, failure, interruption, or plugin reload
and writes no idle catch-up marker. The automatic safeguard never uses it.

## Recall: one protocol, truthful evidence

The standing protocol lives in the `recall` tool description; there is no
per-turn observer/retriever, embedding service, topic graph, or system-prefix
rewrite. Apart from the optional gate notice, live history is left unchanged.

Provide exactly one of `query` or `id`. Addresses accept optional `layer` and
`page` pairs; direct parameters fill only what the address omits:

```text
recall E57
recall E57 layer tools page 2
recall call_<full opaque ID>
recall msg_<full opaque ID>
recall P12
recall catalog
recall catalog all
recall catalog E7
```

Rendered opaque IDs are full, never a fixed-length prefix that might collide.
An exact input ID wins; a unique prefix resolves; ambiguity lists distinct full
candidates. Pages must be positive safe integers, and unreasonable catalog ID
ranges are rejected before allocating a missing-ID list.

| Layer | Fetch an episode | Search |
|---|---|---|
| `conversation` (default) | Dialogue and lean tool/shell/skill/attachment tags | Dialogue homes |
| `tools` | Full calls, shell output, injected skill/attachment text | Call/row originals |
| `full` | Both interleaved | All homes, labeled archive notes, project graduated notes |

Heavy tool arguments/results live in call originals. Shell output, activated
skills, and decoded inline attachment text live in row originals. Dialogue tags
point there rather than duplicating their bodies. Hidden reasoning and provider
metadata are stored with raw rows but not rendered/indexed as conversation.
Search indexes archived data, not already visible live history. Recall-output
echoes are excluded from ranking while retaining fetchable text/page alignment.

BM25 ranks bounded passages, with Unicode-normalized terms and CJK unigrams and
overlapping bigrams. Prefer compact weighted query coverage, whole/quoted phrases
and exact structured identifiers, including their internal punctuation. Keep
original offsets through normalization and do not form matches across recall
echoes. These are bounded ranking preferences, not new mandatory-match filters:
broader lexical evidence remains reachable.

An optional query-only `episode: "E57"` filters by active episode provenance before
ranking. Dialogue and archive notes belong to their episode; row/call originals
carry the episodes that reference them. A scoped miss never widens silently;
graduated notes and off-chain originals have no place in that active scope.
Cached document arrays are not mutated by a per-call scope.

Return up to four focused, deduplicated excerpts per page,
at most 40 ranked results. Notes are explicitly labeled summaries, not original
quotations, and are indexed as the exact `catalog E<n> page N` bytes they point to.
Archived call/row evidence outside the active episode chain is labeled
as such, including potentially reverted work; it remains directly fetchable.

A default fetch returns up to 30,000 characters; larger originals disclose the
remaining pages, each at most 6,000 characters. Explicit pages fetch one page;
catalog listings also return one page per call. Compact catalog entries give
title/time, `catalog E<n>` gives one whole note, and `catalog all` gives the note
view. Pagination preserves surrogate pairs and exact original reconstruction.

Media returns as native file content on the page containing its label, including
direct row/call fetches, not JSON/base64 expansion. The current model must support
that media, and URI-only files must still exist. Archived inline text is decoded
for search. Immutable transcript rendering uses a bounded 8-million-character LRU;
the corpus is cached by checkpoint and invalidated by local archive/chain changes.
Graduated-note caches additionally check the project's durable revision.

## Forks, lifecycle, and privacy

Fork inheritance uses the current awaited `session.hook("fork")`, after native
rows are copied and before the fork returns, with retry on first use. Match
copied checkpoints to the parent's fork-boundary history; reconstruct historical
boundaries from ordered saved cuts if needed. Copy only that branch's records,
rows, and calls into independent child storage and reserve above inherited/source
episode IDs. Commit the import marker last so partial imports are retryable.
Reconstructed checkpoints are not stored as purported original transcript rows.

A completed import survives parent deletion; an archive already lost before
import cannot be recreated. Ordinary subagents do not inherit archives. Forks do
not inherit session model overrides, deferred markers, or transient holds.

Deletion closes local admission immediately and aborts cancellable session work.
A shared per-session write fence admits the durable tombstone and drains already
admitted, non-cancellable writes before final clearing. Other plugin instances
check that tombstone under the same fence and cannot repopulate the namespace.
Owned hook/tool/model-RPC work, telemetry, and relevant writes are tracked; closed
model RPCs reject rather than report a successful no-op. Unload aborts/drains
owned work and clears caches without deleting saved data. Event cleanup rechecks
cancellation after asynchronous ownership resolution.

After draining, read final ownership, intentionally graduate committed notes,
then clear the session namespace. **Deletion is not complete erasure.** Graduated
notes deliberately remain under the owning project and can contain sensitive
information. This is a retention policy, not anonymization or secure deletion of
the database and backups. Raw archive storage is also sensitive and grows with
retained history; protect the OpenCode database accordingly.

Graduation deduplicates exact text against retained notes, skips subagents, and
keeps the 200 most recent notes. Reserve monotonic `P<n>` IDs before writing so
pruning and failed writes cannot recycle an address. Each fetch carries source
session and age. Notes join only full-layer queries, not the session catalog;
their recency multiplier declines from 1 to a positive 0.9 floor over 30 days,
so old matches still rank by relevance. Graduation failures report and do not
prevent raw-session cleanup.

## Model policy, deployment, and verification

`/compact-model` is a TUI picker backed by the schema-validated `nextdcp.model`
RPC. Policies are configured default (`agents.compaction.model`), main, or a
specific provider/model/variant. Read the policy once when a cut needs generation; persist it
outside the checkpoint chain. Saving validates availability but sends no model
request and never changes the session's main model. Reload preserves preferences;
revert does not change them; forks start at default. Warnings are logged, emitted
to clients, and kept in a last-ten timestamped history, not silently discarded.

Ship self-contained ESM server/TUI bundles with `@opencode/plugin` external and
no additional runtime dependencies. The peer range is `>=2.3.2 <3`; the development
SDK is pinned to 2.3.2. There is no older-host adapter. Node 22.18+ runs source
tests with native type stripping; installed bundles require Node 20+.

Local activation uses content-addressed, never-overwritten release directories,
not development `dist`. `release:local` typechecks/tests/builds and prints a URI;
it does not edit host configuration or publish to npm. Deliberately change the
URI and verify the target session's explicit Location, since server defaults can
differ from the terminal directory. Config watching applies the release without
a service restart; retain the old URI for rollback.

Tests cover pure validation/search and controller scheduling, fallback, ownership,
fork reconstruction, and blocked-write deletion/unload races. Request fixtures
are checked against OpenCode 2.3.2 shapes but are not a replacement for the host.
Live activation, a completed custom checkpoint, and retrieval of its newly
archived dialogue/tool originals establish a narrower smoke-test result—not
live proof of every fork, fallback, or deletion path.

Matched task-quality/cost benchmarks and provider calibration traces remain
necessary. Include task success, constraint fidelity, recalls/re-reads, total
input/cache/output cost, repair/fallback requests, and latency. Neither schema
checks nor token reductions establish universal summary fidelity or savings.

### Source map

```text
src/
  index.ts       registration, owned event subscription and cleanup
  runtime.ts     serialized cuts, hooks/tools, scheduling and recall assembly
  lifecycle.ts   task admission, cancellation, write fence and tombstones
  store.ts       session/project persistence, imports and graduation
  memory.ts      cut planning, native adoption, checkpoint chains and rendering
  working.ts     schema, constraint evidence, patches and rendered size
  checkpoint.ts  direct-edit schema/merger and ordered semantic evidence fence
  estimate.ts    retained/growth/evidence/request meters and calibration
  thermostat.ts  versioned adaptive baseline bounds and +50%/−20% updates
  safeguard.ts   fresh-evidence allowance, pause detection and reminder spacing
  recall.ts      readable originals, media, pagination, addresses and BM25
  tokens.ts      text/media estimates
  time.ts        spans and positive-floor recency preference
  prompts.ts     generation contract and standing tool protocol
  models.ts      policy, selected-model generation, warnings and capacity
  model-rpc.ts   nextdcp.model RPC schema
  picker.ts      /compact-model TUI picker
  memory-rpc.ts  read-only nextdcp.memory RPC schema and accounting types
  memory-view.ts /memory TUI dialog, no prompt or model-tool surface
  tui.ts         TUI entry
test/
  support/history.ts  abbreviated current-host request fixtures, tests only
```

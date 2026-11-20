# nextdcp

Task-focused working memory, on-demand `recall`, model-directed
`checkpoint_now` with timely reminders, an adaptive overdue-checkpoint
safeguard, read-only `/memory` accounting and project-lifetime graduated
notes in OpenCode V2 (**v2.3.2+**). The host supplies
`@opencode/plugin`; the declared
peer range is `>=2.3.2 <3`. There are no additional runtime dependencies. The
published package contains separate, self-contained ESM server and TUI bundles;
a source checkout builds them with a development-only esbuild dependency.

## Install locally

Run `npm ci` then `npm run release:local` from a source checkout. This builds,
tests, and copies both bundles to a content-addressed release under the user's
application-data directory: `%LOCALAPPDATA%/opencode/nextdcp/releases/` on
Windows, `~/Library/Application Support/opencode/nextdcp/releases/` on macOS,
and `$XDG_DATA_HOME/opencode/nextdcp/releases/` (or `~/.local/share/…`) on
Linux. Add the printed absolute file URI
to the existing OpenCode configuration, preserving its other settings:

```jsonc
{
  "$schema": "https://opencode.ai/config.json",
  "compaction": { "background": false },
  "plugins": [
    { "package": "file:///path/to/opencode/nextdcp/releases/<version>-<digest>", "options": {} }
  ]
}
```

**`compaction.background: false` is required.** Current OpenCode enables background
compaction by default; its held-summary path does not provide the durable cut this
plugin needs. The obsolete `experimental.background_compaction` key is not a substitute.

Use the actual URI printed by the release script, not the example digest. Do not
run nextdcp alongside another context-management plugin (such as
`opencode-dcp`) in the same session. The package can also be packed with
`npm pack`; no registry
release is assumed. `npm pack` builds automatically; installed packages use the
same bundle through their package entrypoint. **Do not point a live installation
at the development `dist` directory.** Editing or rebuilding source cannot change
an installed release. Build a new release, deliberately change the configured URI,
and verify it in the target session. The release script never overwrites
an existing release or edits OpenCode configuration; the previous URI is a rollback.
The single-file entries avoid stale imported source modules during host reloads.
Use `/reload` to force a reload, then check `opencode api get /api/plugin` for
an active `nextdcp`. The TUI part is discovered from the same directory; no
separate terminal configuration is needed unless terminal plugins were disabled.
Inspect the project's explicit Location: the server's default directory may differ
from the terminal's. A local API client can pass `{ location: { directory: projectPath } }`.

## Compaction model

In a session, run **`/compact-model`** (or **Select compaction model** in the
command palette). The searchable picker includes available text models and
their variants:

| Choice | Behavior |
|---|---|
| **Use configured default** | Honor `agents.compaction.model`, otherwise use the main model. This is the initial policy. |
| **Follow main model** | Ignore the configured compaction model and follow subsequent main-model changes. |
| **Specific model** | Use this model/variant to replace working state and write the archive note in one request. |

The policy is **per session**, survives reloads, and is read once when a cut needs
generation. A fresh main-authored `checkpoint_now` edit skips generation and
does not consult this policy.
Saving it does not change the main model or send a model request. New sessions,
including forks and subagents, start with the configured default, not their
parent's override. Reverting conversation history does not revert this session
preference. To set a default for new and existing sessions using the default
policy, use OpenCode's existing configuration:

```jsonc
{
  "$schema": "https://opencode.ai/config.json",
  "agents": {
    "compaction": { "model": "your-provider/your-model" }
  }
}
```

Choose a model available through your own provider. A specific model uses the
complete new cut's readable text transcript plus the previous working state.
It does not load a directory of old episodes or run a separate merge. This includes complete
original tool text, not host-clipped ranges, and can be larger than the normal
request. Provider metadata and hidden reasoning are not sent as conversation
content. Separate models generally cannot reuse the main model's prompt cache.

If the transcript contains attachments/unsupported content, the selected model
is unavailable, its advertised input/context window cannot fit the estimated
request with output reserved and a safety margin, or generation fails/returns
empty, nextdcp **warns and uses the main model**. It never silently truncates the
transcript to fit. The estimate is conservative, not an exact provider tokenizer;
provider rejections also take this fallback. A failed main-model handoff falls
back to native OpenCode compaction and its configured model. Fallbacks appear in
a toast for the current TUI session, as the last fallback when opening its
picker, in the server process's stderr, and as a timestamped append-only history
(`sessions/<id>/model/warnings`, last 10) in plugin storage. There is no
automatic switch to an arbitrary provider.

Summaries are still lossy. Neither quality-neutral substitution nor lower total
cost is guaranteed; compare representative workloads before choosing a cheaper
default. Original archived data remains available through `recall`.

## Memory status

Run **`/memory`** (or **Show memory status** in the command palette) in a
session. This read-only snapshot shows:

- Working/native summary and the **native recent tail** (none beside a working
  state), separately, in characters and estimated tokens.
- New durable growth and the retained conversation total, its calibration scale,
  and the current threshold: the adaptive baseline plus any temporary fresh
  evidence allowance (automatic mode), or the explicit growth budget.
- The last observed context build's messages, system instructions, tool definitions,
  total projected input, output reserve, margin, and known window/input ceiling.
- The last provider-reported input/cache/output/reasoning counters, separately
  from estimates, plus the last scheduling decision (including a delivered
  checkpoint reminder) and completed/failed cut.
- Recorded checkpoint authorship: main-model edit or compactor generation, when known.

The viewer fits the terminal and scrolls with **↑/↓**, **PgUp/PgDn**,
**Home/End**, or the mouse wheel; **Esc** closes it. It resizes with the terminal
and briefly retries an unavailable RPC while a cold Location loads its plugins.

The row estimates are not additive with the complete request projection: its
messages already include the summary/tail, wrappers, reasoning and injected
content. A hook projection is **not exact provider usage**; later hooks and
transport changes can affect the final request. Missing observations after a
reload are marked unavailable, and a projection from an older checkpoint is
labeled stale. Trigger reasons are in-memory diagnostics, not durable audit logs.

Status neither compacts nor writes storage, adopts archives, changes the
conversation, or sends a model request. There is no model-visible status tool,
automatic status injection, or automatic tail tuning. Reopen the command for a
fresh snapshot. The same read-only surface is available through the
`nextdcp.memory` RPC's `get({ sessionID })` method, at the session's Location.

## Working-state checkpoints

At a natural pause, choose one of two paths:

- **`checkpoint_now({})`** lets the compactor use the conversation and prior state
  it already receives. Do not write a preliminary recap for it.
- **`checkpoint_now({ archive, working })`** lets the main model author the compact
  state directly, without a second model rewriting it. For example:

```js
checkpoint_now({
  archive: "Title: Callback fix\nFixed the callback race in src/auth.ts; test/auth.test.mjs passes.",
  working: {
    state: ["Callback race fixed; focused auth tests pass. Full suite not yet run."],
    next: ["Run the full suite, then verify the installed release."],
  },
})
```

- The base is the **latest canonical working state**, including earlier main-authored
  edits. Omitted fields carry forward. A changed list replaces the old list, rather
  than appending a growing notes log.
- Keep only information whose loss would change the next decision, risk an incorrect
  action, or cause substantial rediscovery. Drop completed bookkeeping and cheaply
  recoverable detail; do not copy instructions already supplied by OpenCode/`AGENTS.md`.
  Replace stale `state`/`next` lists explicitly: an omitted field remains unchanged.
- New standing constraints must **themselves be the shortest self-contained exact
  quotes from new user text**, including human replies to the built-in `question`
  tool. No duplicate proof payload is needed. Host rules,
  assistant plans and task requirements do not belong here; task requirements live
  in `state`/`next` only while that task is active.
- Existing constraints, including legacy entries, survive omission. Explicit user
  withdrawal or correction of a misattributed rule uses
  `retire: [{ constraint: "exact old constraint", quote: "verbatim new-user evidence" }]`.
  Quotes resolve only against actual new user text or completed `question` calls'
  structured human answers, never arbitrary tool prose/metadata, attachments, skill
  bodies, queued hints or old archives. Validation proves source text, not its intent;
  the author must distinguish instructions from quotations and temporary requirements.
- The short `archive` note is required for a direct edit. Its first line is
  `Title: <episode name>`, followed by 1–3 brief new outcome/search-cue sentences:
  cold search evidence, not a second copy of the working state.
- With no structured prior state, supply all working fields (`objective`,
  `constraints`, `state`, `next`, `references`) or call **`checkpoint_now({})`** to
  let the compactor seed it. `{}` always requests compactor generation.
- There is **no arbitrary edit-payload cap**. The entire merged state is measured
  against `memory.budget` as a **soft target**; the tool asks for under ~1k tokens
  without history or detail that files or `recall` restore. A valid main-authored
  over-budget state warns and commits without truncation or a second size-only rewrite.

Use the tool as the **only tool call in its step**. At the actual cut, originals
are archived and the proposal is revalidated against its base and the evidence
seen at the main-model build. New user input, other tool results, changed evidence,
or a missing observation after reload selects safe compactor regeneration instead
of committing stale state. Malformed edits are refused before admission. An
uncommitted proposal is transient; a committed state and its authorship are durable.

**Admission is not completion.** The tool reports **Requested**, **Already pending**,
**Not admitted**, or **Failed**. Requested means the control was admitted for the next
step boundary, not that an archive or replacement summary already exists. Pending,
duplicate-boundary and three-minute cooldown safeguards remain; there is **no
once-per-round limit** after a successful cut moves the boundary. A duplicate cannot
replace an already staged proposal, and a refused edit cannot leak into a later cut.
Completion is observed separately through host outcomes and `/memory`; the tool
never waits for the cut that needs its own step to finish.

## Checkpoint guidance and the overdue safeguard

`checkpoint_now` is the primary path: the model checkpoints at natural pauses.
The plugin only adds short, timely guidance, then a bounded fallback for a model
that neglects it. **Complete-request capacity is checked first on every build**;
nothing below can postpone it.

### Reminders at natural pauses

Work usually alternates between gathering (tool batches, often parallel or in
salvos), thinking, and stating conclusions before acting again. A reminder is
offered mid-round when the latest completed step **paused**:

- it stated conclusions (at least ~60 estimated tokens of visible text) about
  the model's own previous tool work, and kept working by calling tools; and
- its own results/errors and any newer input are still unseen only in small
  amounts (at most 5% of the baseline) and no tool failed in that step; and
- new conversation since the checkpoint, and since the previous reminder, is
  at least 25% of the baseline, so a checkpoint would free meaningful room.

A reply to a user message, a steering message, or a pending `question` answer
is not a pause: human input comes first. A finished round is not one either:
if compaction is due when a turn succeeds, it runs before the next message is
admitted, steered by that message, without spending an extra full-context step.

The ~70-token notice says how much work has accumulated, names a nearby
overdue safeguard, and asks the model to checkpoint **only** if its conclusions
cover what comes next and the raw outputs won't be needed again; otherwise it
continues. Preferring a directly authored `archive` + `working` skips a second
generation. Separately, when the complete projected request reaches 85% of
safe capacity, one headroom warning per checkpoint advises avoiding large new
reads and checkpointing at the next pause.

Reminders never queue a cut. They are spaced by real progress, not by hook calls
or time; an identical rebuild/retry replays one the model has not answered yet.
They are request-scoped tail messages, are omitted if they would not fit safe
capacity, and are skipped with `notice: "system"` because a system part would
rewrite the cached prefix of the whole request for an optional suggestion. They
accompany the automatic safeguard only. The thresholds are heuristics, not
measured quality boundaries; reminders state no context-rot limit.

### Fresh evidence keeps working room

Reading files, compacting them immediately, then reading them again is the
waste to avoid. Successful tool results and foreground shell output since the
last **successfully completed turn** therefore raise the live threshold on the
very build that carries them. Each result keeps full credit for 12 assistant
steps, then declines to none by step 28; later reads cannot make older results
young again. The temporary allowance is 1.5× that weighted evidence (room to
read it and work with it), capped so that baseline plus allowance never exceeds
safe input capacity minus fixed request overhead. A successful turn end resets
it, matching next-prompt scheduling; an interruption, failure or steering
message continues the same work and keeps it. It is never persisted and never
trains the baseline. Pasted user text and generated output are not tool evidence.

If fresh evidence brings an already-open gate back within the live threshold,
that gate is cancelled rather than repaid at round end.

### The overdue gate

When the retained conversation exceeds the live threshold mid-round,
compaction pauses for one evaluation step. The model receives one automated
notice — appended as the final conversation message, labeled as automated rather
than a human request (encoded with the provider's user role) — with the
estimate, threshold and share of the model window, and decides in that reply:

- **Continue (default):** the next step still runs with full raw context; the
  cut lands right after it. Any other tool call or plain text means continue.
- **`checkpoint_now`:** supply working-state edits as the step's sole tool call.
  A fresh valid edit avoids a second generation.
- Delegate a suitable independent part to a subagent with its own window, if authorized.

**No speculative compactor summary is generated.** Archiving and any required
generation begin only at the actual host cut. An open gate is a schedule, not an
admitted control: `checkpoint_now` admits and stages supplied edits normally.
A crossing with no live round, a staged revert, or compaction already running
or cooling down does not open a gate. A staged revert or running compaction is
left alone; without a live round, an eligible crossing compacts silently. A
round that ends before its next build repays the consumed crossing. A gate notice
that would itself exceed capacity yields to capacity recovery. Gate, checkpoint
and capacity outcomes are counted per session in plugin storage; deleting the
session removes them.

## Adaptive baseline

The automatic threshold meters the **retained conversation**: current summary,
native recent tail and new durable rows, excluding ephemeral reasoning. System
instructions, tool schemas and wrappers belong to the separate capacity check.
The baseline is persisted per main model under the session's actual project ID.

It starts at `min(200000, 50% of the window, safe capacity)`, normally within
150k–300k (75%–150% of the start, never above capacity). Each committed custom
handoff folds the cycle's **routine** growth per assistant step — durable growth
minus returned tool/shell evidence — and its span into half-weight EMAs. The
target is the retained conversation at the cycle's start plus 28 steps of
routine growth, clamped to the bounds; each update moves at most **+50% or −20%**,
except when a changed window forces an immediate clamp. Older unversioned
learning reseeds at the start value.

The default idle path uses the baseline (a successful turn end resets the
evidence allowance). An explicit `budget` keeps its historical meaning: a threshold on **new
durable growth**, without reminders or evidence allowance. `idle` can
independently override or disable next-prompt scheduling. Subagents and
unknown windows do not train the baseline; storage failures report and fall
back to defaults.

Neither 200k, 28 steps nor the step limits are measured quality or cost optima,
and the baseline is a fallback for overdue checkpoints, not a recommended
cadence. Matched workload benchmarks are still needed before making such claims.

## Graduated notes

Deleting a session first graduates its committed episode notes into a
project-lifetime archive (`projects/<projectID>/episodes/P<n>`): notes only,
deduplicated against retained notes by exact text, capped at the 200 most recent.
The plugin's raw session archive is cleared — the note becomes the
fetchable original. A fresh session finds them through `recall` two ways:
`recall P12` returns the whole note with stable provenance (source session),
and full-layer queries search the same text alongside live archive evidence.
Relative age appears on search-result labels, never in the paginated original.
A small 30-day recency preference and a positive 0.9 floor keep old notes
ranking by relevance. IDs are never recycled, including after pruning.
Graduated notes never appear in the episode catalog, and
subagent sessions never graduate.

Older unowned `project/*` records are not read, reassigned to a guessed project,
or deleted automatically by 0.14. Project notes and learned budgets now use only
the owning project's namespace; existing session archives are separate.

**Deleting a session is not complete erasure of its summaries.** Committed notes
deliberately survive under that project and can contain sensitive material.
Deletion closes the namespace with a durable tombstone, cancels and drains
in-flight owned session work/writes, graduates notes, then clears raw session storage.
Unload drains work without deleting saved data. Global lifecycle events are
routed by their Location or persisted ownership; missing ownership is not guessed.
This is not secure erasure of the database or its backups.

## Explicit-budget spike hold

This compatibility behavior applies only to an explicit positive `budget`
(new-durable-growth scheduling); the automatic safeguard uses fresh-evidence
room instead and is never postponed by a learned-rate spike or a tool error.

When an explicit-budget crossing in a live round meets both conditions:

- the last ten assistant turns grew at **twice** the model's learned per-turn
  rate, and
- the **complete projected request** still fits the model's context and any
  separate input limit after reserving output and a safety margin,

the round's soft cut is held automatically: no notice and no tool call.
Capacity is rechecked on **every build** before honoring a hold. The hold
expires when the round ends, on completion, failure, interruption, or plugin
reload, writes no deferred idle marker, and is never persisted or inherited.
Until a model has a learned rate, crossings open the gate as usual. An explicit
budget also postpones its soft cut for two minutes after a tool failure.

## Options

All options are optional and go inside the plugin's `options` object. Token
counts are estimates, not provider billing counts: text is estimated at four
characters per token, except Han, kana and hangul characters, which count as
roughly one token each. Where estimates are compared against a model's window,
they are calibrated toward real tokens using the provider's own reported usage
from recent completed requests; without such usage the raw estimate applies.

| Option | Default | Meaning |
|---|---:|---|
| `idle` | adaptive baseline (or explicit `budget`) | After a successful turn at or above this threshold with new durable growth, compact on the **next prompt**, not while idle. Automatic mode compares the retained conversation; a positive number compares new durable growth; `false` disables this path. Subagent sessions are ignored. |
| `budget` | adaptive retained-conversation safeguard | Default: the overdue-checkpoint safeguard plus pause reminders and fresh-evidence room. An explicit positive number instead sets a mid-round **new durable growth** threshold (no reminders or evidence room); `false` disables soft gates and reminders, not capacity safety. See [Checkpoint guidance](#checkpoint-guidance-and-the-overdue-safeguard). |
| `notice` | `tail` | Placement of gate notices: `tail` appends a request-scoped final message (no cached-prefix churn); `system` uses a system part for providers that drop trailing messages and disables optional reminders. |
| `memory.budget` | `2000` | Soft target for the complete rendered working state, including headings and references. Valid main-authored edits warn and commit above it without regeneration. Compactor generation aims about 1000 or less and can use one repair attempt; constraints are never truncated. |
| `debug` | `false` | Include debug diagnostics in the server log. Archive, inheritance and native-fallback warnings are logged regardless. |

If the model's window is unavailable, the plugin does not guess it: the
auto soft trigger and plugin capacity checks are skipped. Explicit soft thresholds
still work; nextdcp does not disable native host overflow recovery. A separate model must
advertise enough safe input capacity. `idle: false` and `budget: false` do not
disable manual compaction or the complete-request capacity check for known windows.

## How it works

Compaction is the single elision boundary: the conversation runs raw through
the round, and only the compaction summary replaces it. Original rows and tool
calls are saved in OpenCode's plugin storage before the summary replaces them,
so omitted details return through `recall`.

A fresh validated `checkpoint_now` edit supplies the replacement state and cold
archive note directly: **zero compaction-generation requests**. Automatic cuts,
`checkpoint_now({})`, and stale-proposal fallback use the compactor. Its first
request runs in **patch mode** when the current state is structured; it returns
only changed fields, validated as the merged whole. This can reduce output tokens
but is not a total-cost guarantee. **At most two generation attempts are shared
across patch mode, full regeneration, repair and selected-model fallback.**
Every retry carries its failure; a repeated hook reuses an already committed
checkpoint rather than generating again. Only the current objective, standing constraints,
relevant verified state, unfinished work, and at most three evidence references
are kept visible. Completed work is archived, not appended to the handoff.
Inline generation already sees the checkpoint and user text, so its prompt does
not repeat the prior state or a directory of user-message snippets. A stateless
compaction model still receives the complete prior state and readable new cut.
The validator resolves retirement quotes to user IDs without asking the model to
copy those IDs. A native fallback's separately protected constraints are supplied
when its textual summary may have omitted them.
No topic classifier, observer model, embedding service, or merge request runs.
Recall returns readable transcripts, with complete originals returned in one call
up to 30,000 characters and larger originals available through
pages of at most 6,000 characters. Everything recall returns stays live for the
rest of the episode. Images, PDFs, and attachments return as native files on the
page containing their attachment label, not as JSON or base64 text. Inline text
attachments are decoded and searchable. The selected model must support the
attachment's media type; URI-only files must still exist.

Keyword search covers archived notes, transcript passages, and originals of elided
tool data. Results return up to four focused, deduplicated excerpts per page,
with fetchable IDs/pages; a sufficient excerpt needs no follow-up fetch. At most
40 ranked hits are exposed per query. Lightweight BM25 favors compact query
coverage, whole/quoted phrases and exact structured identifiers (paths, symbols,
error codes), without silently dropping broader lexical matches. Quoting is a
ranking preference, not a mandatory-match filter. If the relevant episode is
known, add a query-only scope, for example
`recall({ query: "requestCompact", episode: "E16", layer: "tools" })`.
This searches only that active episode's evidence; it never silently widens a
miss to other episodes, off-chain originals or project graduated notes.
Archive-note matches are labeled summaries and point to `catalog E<n> page N`,
whose fetch returns that note, not a different transcript. Words crossing page boundaries remain
searchable, including common CJK substrings. Rendered opaque addresses use full
IDs; unambiguous input prefixes are still accepted. Searchable tool/row originals
outside the active checkpoint chain are labeled as such (for example after a
revert), not silently presented as current-branch evidence. Provider metadata and
reasoning are omitted. OpenCode still controls the compaction cut. A working
state replaces the whole cut, so it sets `metadata.keepID: null` and OpenCode
keeps no verbatim recent tail beside it (the host tail walks back to the latest
user message regardless of `compaction.keep.tokens` and would duplicate the
state). Native fallbacks keep OpenCode's tail.

Ending a successful turn counts the final retained assistant reply and tool data,
not ephemeral reasoning,
then only records that soft-threshold compaction is due;
it does not generate a summary. If you send another prompt, compaction runs
before that message is admitted, leaving the new request verbatim after the
checkpoint. The queued message's text is passed to the working-state model as a
labeled relevance hint — evidence for what stays live, never instructions, and
it cannot retire constraints (retirement requires an exact quote from a real
user row). Merely reopening the session does nothing. The marker survives
reloads and only applies to the same conversation boundary, not a staged revert,
changed branch or subagent. Manual compaction is unchanged.

This avoids paying for a summary of a conversation you never resume. The
tradeoff is a pause when you resume and possibly a colder provider prompt cache;
the eventual summary is not guaranteed to have the same cache discount as one
generated immediately.

The separate capacity check measures the **complete hook request projection** on
every eligible build, reserves explicit requested output (or the model's output limit), honors a
separate input ceiling, and keeps a 1,024-token estimation margin. It bypasses
soft gates and holds when new growth can be compacted. Compaction cannot solve a
request dominated by fixed instructions/tool schemas; the estimate is not an
exact tokenizer, and later hooks/transport changes can affect the final request.
OpenCode's native overflow recovery remains the backstop when enabled. A
per-session compaction guard clears on completion, failure, rejected
admission, a later successful execution with no compaction running, or after
three minutes. After a failed compaction, the plugin waits three minutes before
requesting another. Model-window lookups are cached per provider and model.
Deleting a session graduates its episode notes into the project archive (see
[Graduated notes](#graduated-notes)) and removes its archived data and gate
counters. A durable tombstone keeps session writes closed while raw cleanup is
pending. Failed clears remain journaled and retry on startup/reconnect and after
failures, with capped backoff independent of the event stream; one failing
session does not prevent other pending cleanups. Failures warn even without
debug logging. Only a successful clear marks cleanup complete, and its tombstone
remains to prevent stale instances from recreating the archive.

Forks copy their inherited checkpoint chain and original rows/tool calls
into independent storage. Copied checkpoint IDs are matched against the
parent's history at the fork boundary. Historical boundaries are reconstructed
from ordered archive cuts when the parent has compacted or reverted since.
Episode IDs stay stable; new IDs cannot
collide with inherited ones. Import uses the awaited current-host fork hook,
after host rows are copied and before the fork returns, with a retry on
first use, and survives parent deletion once complete. Ordinary subagents do
not inherit archives. A parent archive already lost before import cannot be
reconstructed by the plugin.

Writes are serialized by durable key in-process across host contexts and hot reloads,
including episode counters, original tool calls, and fork imports.

Compactions archive only the new cut and its completed parent checkpoint, not
all prior history again. Fork imports are one-time copies; archive storage still
grows with the original history retained.

Archived conversation rows and complete tool data may contain sensitive
information. They are stored in the OpenCode database, so protect its access
and backups accordingly.

## Limitations

- Require `compaction.background: false` (OpenCode's default is `true`).
  Unsupported background preparation is refused with an explicit warning; a
  later native checkpoint adopted without an archived cut discloses a recall gap.
- Individual archive failures are logged and skipped; other items are saved
  and the episode is marked with a recall gap. Conflicting tool-call IDs keep
  the first archived original. Failure to save essential checkpoint metadata
  or produce a valid handoff falls back to native compaction.
- The memory budget is checked against the entire rendered state. Valid main
  edits above the soft target commit unchanged with a warning and no generation.
  When generation is required, the plugin gets at most two attempts; unsupported-input checks
  conservatively consume an attempt too. Native host fallback can make its own
  request afterward. Constraints are never truncated to make the budget pass. A valid
  but over-budget compactor handoff commits as the shortest valid artifact, disclosed
  by a warning, rather than falling back to native; native compaction takes
  over only when no valid handoff was produced, and is a reported exception
  to the plugin's memory budget, not a secretly successful bounded checkpoint.
- A native textual fallback invalidates stale structured state. The next full
  regeneration receives that native summary and still-active standing constraints,
  rather than patching the pre-fallback state as if nothing happened.
- Standing constraints survive accidental model omission. Removing one requires
  explicit new-user withdrawal or misattribution correction with a verbatim quote;
  the validator records its source row. Task-local requirements
  belong with unfinished work, not the permanent constraint list. Mechanical
  validation cannot prove semantic completeness or that a retirement is justified.
- An opaque provider-native checkpoint with no textual summary stays under
  native control rather than being replaced. Episode-based recall, archive
  search, and later custom episodes may be unavailable on that chain; an
  already archived tool call remains directly retrievable by its ID.
- Native compaction renders its recent tail as text and clips individual tool
  outputs; the archived originals are available through `recall` when the
  archive is intact.
- Enabling the plugin after history was already compacted cannot restore raw
  data that it never archived. Summaries remain lossy; recall must be used for
  omitted details. Lower token usage does not by itself guarantee lower total
  cost or better task accuracy.

From a source checkout, run `npm test` with Node.js 22.18+ (native TypeScript
type stripping). It builds the shipped entry before running the TypeScript
tests; `npm run typecheck` checks `src/` under `strict` mode.

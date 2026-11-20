# nextdcp

Bounded task-focused working memory, on-demand `recall`, a budget gate with
`checkpoint_now`, an adaptive compaction budget, project-lifetime graduated
notes, and an automatic round-scoped spike hold for bulky rounds in
OpenCode V2 (**v2.2.5+**). The host supplies
`@opencode/plugin`; the declared
peer range is `>=2.2.5 <3`. There are no additional runtime dependencies. The
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
  "plugins": [
    { "package": "file:///path/to/opencode/nextdcp/releases/<version>-<digest>", "options": {} }
  ]
}
```

Use the actual URI printed by the release script, not the example digest. Do not
run nextdcp alongside another context-management plugin (such as
`opencode-dcp`) in the same session. The package can also be packed with
`npm pack`; no registry
release is assumed. `npm pack` builds automatically; installed packages use the
same bundle through their package entrypoint. **Do not point a live installation
at the development `dist` directory.** Editing or rebuilding source cannot change
an installed release. Publish a new release, validate it on a private server,
then deliberately change the configured URI once. The publisher never overwrites
an existing release or edits OpenCode configuration; the previous URI is a rollback.
The single-file entries avoid stale imported source modules during host reloads.
Use `/reload` to force a reload, then check `opencode api get /api/plugin` for
an active `nextdcp`. The TUI part is discovered from the same directory; no
separate terminal configuration is needed unless terminal plugins were disabled.
Use the project's Location when inspecting plugins (`--param 'location[directory]=C:\path\to\project'`).

## Compaction model

In a session, run **`/compact-model`** (or **Select compaction model** in the
command palette). The searchable picker includes available text models and
their variants:

| Choice | Behavior |
|---|---|
| **Use configured default** | Honor `agents.compaction.model`, otherwise use the main model. This is the initial policy. |
| **Follow main model** | Ignore the configured compaction model and follow subsequent main-model changes. |
| **Specific model** | Use this model/variant to replace working state and write the archive note in one request. |

The policy is **per session**, survives reloads, and is read once per compaction.
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

## The budget gate

When the raw conversation crosses the `budget` threshold mid-round, compaction
pauses for one evaluation step. The model receives one automated notice —
appended as the final conversation message, labeled as automated, never a user
message — with the estimated tokens, the budget, and the share of the model
window, and decides in that reply:

- **Continue (default):** the next step still runs with full raw context; the
  cut lands right after it. Any other tool call or plain text means continue.
- Delegating the bulky independent part to a subagent with its own window.

A bulky round may never see the notice at all: when the recent turns grow at
twice the learned rate and the conversation still fits the window, the
crossing is held for the round automatically — see
[Automatic spike hold](#automatic-spike-hold).

The evaluation window doubles as the generation window: while the model reads
the notice, the would-be episode is archived and its handoff is generated
statelessly in the background. When the gate closes on continue — the common
case — the cut commits that precomputed handoff with no additional model
request, so the gate adds no latency at the cut. A held round, an explicit
`checkpoint_now` keep note, or any boundary that moved past what the
window covered discards it, and that cut generates inline exactly as before.
Calling `checkpoint_now` while a gate is open is an alias for continue — the
cut lands one step later anyway — with the optional `keep` still riding to the
working-state model as relevance evidence; outside a gate it cuts immediately,
approval-free and once per round, at a natural pause before a context-heavy
phase (large reads, refactor, verbose build) so that phase starts from the
small working state.

The whole regime — gate, recall, checkpoint — is stated once in the `recall`
tool description, so the notice itself stays a short trigger. A crossing with
no live round, a staged revert, or compaction already running or cooling down
compacts silently, as before. A round that ends before its next build repays
the consumed crossing immediately. Gate, spike-hold, checkpoint, and precompute
outcomes are counted per session in plugin storage; deleting the session
removes them.

## Adaptive budget

The `budget` threshold is learned per **main model** from the transcript's own
shape. A cycle spans one committed checkpoint to the next — about one budget
by construction — so it already integrates the signal; the law works in turn
space, where token-estimator bias cannot reach. Each completed cycle folds
two exponential moving averages at half weight — calibrated durable tokens
per assistant turn (the growth rate) and assistant turns per cycle (the
measured span) — persisted per model in plugin storage and shared by every
session of the project.

The budget then takes at most one rate-limited step per cycle — ±20% toward
a cycle span of 28 turns, and never below growth × 12, so cuts come no faster
than the transcript's own rate allows — always clamped to
`[30000, min(50% of the model window, 150000)]`, starting from `min(50% of
the model window, 100000)`. The 150k ceiling is deliberate: measured quality
on current frontier models holds to roughly 150k tokens of live context even
on very large windows, and several providers start premium pricing at 200k.

An explicit `budget` option wins absolutely; subagent sessions and unknown
model windows never feed the loop; every thermostat failure reports and falls
back to the static default.

## Graduated notes

Deleting a session first graduates its committed episode notes into a
project-lifetime archive (`project/episodes/P<n>`): notes only, deduplicated
by exact text so fork copies never land twice, capped at the 200 most recent.
Raw transcripts and tool calls die with the session — the note becomes the
fetchable original. A fresh session finds them through `recall` two ways:
`recall P12` returns the whole note with its provenance (source session,
age), and full-layer queries search them alongside live archive evidence,
with a 30-day recency boost so fresh experience outranks stale advice on
equal term matches. Graduated notes never appear in the episode catalog, and
subagent sessions never graduate.

## Automatic spike hold

Bulk work — wide file reads, verbose builds, data dumps — can cross the budget
mid-round while still comfortably fitting the model window. Cutting there
would shred work that `recall` cannot reassemble cheaply. When a live-round
crossing meets both conditions:

- the last ten assistant turns grew at **twice** the model's learned per-turn
  rate — a rate spike, evidence of bulk payload rather than conversation — and
- the calibrated conversation still fits within 80% of the model's context
  window after reserving its output limit (an unknown window never holds),

the round's cut is held **automatically**: no notice, no approval prompt, no
tool call. The raw conversation stays fully live for the rest of that round —
later crossings of the same round are held too — and the hold expires when
the round ends, on completion, failure, interruption, or plugin reload. The
held round writes no deferred idle marker: the next round starts from the
full context and either re-affirms or lets the budget trigger catch up in one
bounded compaction. The hold is never persisted and is not inherited by forks
or subagents; manual compaction, native overflow handling, and in-flight
compaction are unaffected. Until a model has a learned rate — the first
cycles — its crossings open the budget gate as usual instead.

## Options

All options are optional and go inside the plugin's `options` object. Token
counts are estimates, not provider billing counts: text is estimated at four
characters per token, except Han, kana and hangul characters, which count as
roughly one token each. Where estimates are compared against a model's window,
they are calibrated toward real tokens using the provider's own reported usage
from recent completed requests; without such usage the raw estimate applies.

| Option | Default | Meaning |
|---|---:|---|
| `idle` | `25000` | After a successful turn with this much new conversation, compact on the **next prompt**, not while idle. Set `false` to disable. Subagent sessions are ignored. |
| `budget` | adaptive per model (initial `min(50% of model window, 100000)`) | Compact during a turn when conversation tokens remain above this and new growth reaches `min(idle, budget / 4)`. The default is learned per main model from the transcript's own shape — see [Adaptive budget](#adaptive-budget); bounds `[30000, min(50% of model window, 150000)]`. A live-round crossing first opens the budget gate. System instructions and tool definitions are excluded. Set `false` to disable. |
| `notice` | `tail` | Placement of the budget-gate notice: `tail` appends it as the final conversation message (no cached-prefix churn); `system` uses a system part for providers that drop trailing messages. |
| `memory.budget` | `2000` | Maximum estimated tokens for the complete rendered working state, including headings and references. Target is normally about 1000 or less. Independent of conversation age and model window. |
| `debug` | `false` | Include debug diagnostics in the server log. Archive, inheritance and native-fallback warnings are logged regardless. |

If the model's window is unavailable, the plugin does not guess it: the
default conversation hard-budget trigger is skipped. The explicit working-state
budget still applies; a separate model must advertise enough safe input capacity.

## How it works

Compaction is the single elision boundary: the conversation runs raw through
the round, and only the compaction summary replaces it. Original rows and tool
calls are saved in OpenCode's plugin storage before the summary replaces them,
so omitted details return through `recall`.

During compaction, one request produces a replacement working state and a short
searchable archive note. When the prior working state is structured, that request
runs in **patch mode** — the model returns only changed fields, validated as the
merged whole under the same schema and budget checks — so generation cost scales
with what changed, not with state size; an invalid patch falls back to one fresh
full regeneration. Only the current objective, standing constraints,
relevant verified state, unfinished work, and at most three evidence references
are kept visible. Completed work is archived, not appended to the handoff.
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
40 ranked hits are exposed per query. Archive-note matches are labeled as such,
not presented as original quotations. Words crossing page boundaries remain
searchable. Row IDs, provider metadata and
reasoning are omitted. OpenCode still controls the compaction cut and recent tail.

Ending a successful turn counts the final assistant reply and reasoning too,
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

The hard-budget trigger still runs immediately during long turns and counts
conversation only; a live-round crossing opens the budget gate instead of
compacting at once. OpenCode's native overflow handling still applies to system
instructions and tool definitions. A
per-session compaction guard clears on completion, failure, rejected
admission, a later successful execution with no compaction running, or after
three minutes. After a failed compaction, the plugin waits three minutes before
requesting another. Model-window lookups are cached per provider and model.
Deleting a session graduates its episode notes into the project archive (see
[Graduated notes](#graduated-notes)) and removes its archived data and gate
counters.

Forks copy their inherited checkpoint chain and original rows/tool calls
into independent storage. Copied checkpoint IDs are matched against the
parent's history at the fork boundary. Historical boundaries are reconstructed
from ordered archive cuts when the parent has compacted or reverted since.
Episode IDs stay stable; new IDs cannot
collide with inherited ones. Import happens on the fork event, with a retry on
first use, and survives parent deletion once complete. Ordinary subagents do
not inherit archives. A parent archive already lost before import cannot be
reconstructed by the plugin.

Writes are serialized by durable key across host contexts and hot reloads,
including episode counters, original tool calls, and fork imports.

Compactions archive only the new cut and its completed parent checkpoint, not
all prior history again. Fork imports are one-time copies; archive storage still
grows with the original history retained.

Archived conversation rows and complete tool data may contain sensitive
information. They are stored in the OpenCode database, so protect its access
and backups accordingly.

## Limitations

- Keep OpenCode's `experimental.background_compaction` disabled
  (the default).
  Its precomputed native summary can be applied without rerunning the plugin's
  hook, leaving a recall gap.
- Individual archive failures are logged and skipped; other items are saved
  and the episode is marked with a recall gap. Conflicting tool-call IDs keep
  the first archived original. Failure to save essential checkpoint metadata
  or produce a valid handoff falls back to native compaction.
- The memory budget is checked against the entire rendered state, and every
  failed attempt gets at most one repair that carries the exact validation
  failure. Constraints are never truncated to make the budget pass. A valid
  but over-budget handoff commits as the shortest valid artifact, disclosed
  by a warning, rather than falling back to native; native compaction takes
  over only when no valid handoff was produced, and is a reported exception
  to the plugin's memory budget, not a secretly successful bounded checkpoint.
- Standing constraints survive accidental model omission. Removing one requires
  a cited new user row and a verbatim quote from it. Task-local requirements
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

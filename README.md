# nextdcp

Bounded task-focused working memory, deterministic tool-output masking, and on-demand `recall` for
OpenCode V2 (**v2.2.5+**). The host supplies `@opencode/plugin`; the declared
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
    { "package": "file:///C:/Users/you/AppData/Local/opencode/nextdcp/releases/0.4.0-DIGEST", "options": {} }
  ]
}
```

Use the actual URI printed by the release script, not the example digest. Remove or disable the old
`opencode-dcp` plugin before enabling nextdcp; do not run both on
the same session. The package can also be packed with `npm pack`; no registry
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
It does not load a directory of old episodes or run a separate merge. This includes original
tool text, not just masked stubs, and can be larger than the normal masked
request. Provider metadata and hidden reasoning are not sent as conversation
content. Separate models generally cannot reuse the main model's prompt cache.

If the transcript contains attachments/unsupported content, the selected model
is unavailable, its advertised input/context window cannot fit the estimated
request with output reserved and a safety margin, or generation fails/returns
empty, nextdcp **warns and uses the main model**. It never silently truncates the
transcript to fit. The estimate is conservative, not an exact provider tokenizer;
provider rejections also take this fallback. A failed main-model handoff falls
back to native OpenCode compaction and its configured model. Fallbacks appear in
the server log, in a toast for the current TUI session, and as the last fallback
when opening its picker. There is no automatic switch to an arbitrary provider.

Summaries are still lossy. Neither quality-neutral substitution nor lower total
cost is guaranteed; compare representative workloads before choosing a cheaper
default. Original archived data remains available through `recall`.

## Defer compaction for one round

For work that genuinely needs unusually large simultaneous context, the model can
call `defer_compaction` with a concrete reason why checkpointing plus recall would
impair the current task. The tool uses OpenCode's native approval prompt (permission
`defer_compaction`, default `ask`), including **Always allow**. Configured permission
rules are respected. Each round still needs its own tool call; a refusal cannot be
retried in that round.

The reason is visible in the tool call and in the GUI's approval card; the terminal's
generic approval box shows the tool name, with the reason in the tool call above it.

Approval suppresses only NextDCP's automatic **mid-round budget trigger**. Masking,
manual compaction, native overflow handling, and normal deferred compaction before
the next round remain enabled. Already-queued compaction is not canceled. The
exemption expires on completion, failure, interruption, or plugin reload and is not
inherited by forks or subagents. Native permission choices retain OpenCode's usual
scope; the exemption itself is never persisted.

## Options

All options are optional and go inside the plugin's `options` object. Token
counts are estimates, not provider billing counts: text is estimated at four
characters per token, except Han, kana and hangul characters, which count as
roughly one token each.

| Option | Default | Meaning |
|---|---:|---|
| `idle` | `25000` | After a successful turn with this much new conversation, compact on the **next prompt**, not while idle. Set `false` to disable. Subagent sessions are ignored. |
| `budget` | `min(50% of model window, 100000)` | Compact during a turn when conversation tokens remain above this after masking and new growth reaches `min(idle, budget / 4)`. System instructions and tool definitions are excluded. |
| `mask.minTokens` | `400` | Minimum size, exclusive, of a tool result or input string to consider. |
| `mask.distance` | `20000` | Minimum distance, exclusive, from the end of the request. |
| `mask.batch` | `10000` | Minimum estimated tokens saved before committing new masks. |
| `mask.protected` | `skill`, `todowrite`, `todoread`, `task`, `subagent` | Tool names never newly masked. Supplying this list replaces the default. |
| `memory.budget` | `2000` | Maximum estimated tokens for the complete rendered working state, including headings and references. Target is normally about 1000 or less. Independent of conversation age and model window. |
| `debug` | `false` | Include debug diagnostics in the server log. Archive, inheritance and native-fallback warnings are logged regardless. |

If the model's window is unavailable, the plugin does not guess it: the
default conversation hard-budget trigger is skipped. The explicit working-state
budget still applies; a separate model must advertise enough safe input capacity.

## How it works

Before a mask or compaction, original data is saved in OpenCode's plugin
storage. Old tool results and large input fields can then be replaced with
short notices. Masks are stored per checkpoint, so a revert restores that
checkpoint's masks. A batch normally meets `mask.batch`; if one item cannot be
archived, other successfully archived items can still be masked.

During compaction, one request produces a replacement working state and a short
searchable archive note. Only the current objective, standing constraints,
relevant verified state, unfinished work, and at most three evidence references
are kept visible. Completed work is archived, not appended to the handoff.
No topic classifier, observer model, embedding service, or merge request runs.
Recall returns readable transcripts, with complete originals available through
pages of at most 6,000 characters. Images, PDFs, and attachments return as native files on the
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
checkpoint. Merely reopening the session does nothing. The marker survives
reloads and only applies to the same conversation boundary, not a staged revert,
changed branch or subagent. Manual compaction is unchanged.

This avoids paying for a summary of a conversation you never resume. The
tradeoff is a pause when you resume and possibly a colder provider prompt cache;
the eventual summary is not guaranteed to have the same cache discount as one
generated immediately.

The hard-budget trigger still runs immediately during long turns and counts
conversation only; OpenCode's native overflow handling still applies to system
instructions and tool definitions. A
per-session compaction guard clears on completion, failure, rejected
admission, a later successful execution with no compaction running, or after
three minutes. After a failed compaction, the plugin waits three minutes before
requesting another. Model-window lookups are cached per provider and model.
Deleting a session removes its archived data.

Forks copy their inherited checkpoint chain, original rows/tool calls, and live
masks into independent storage. Copied checkpoint IDs are matched against the
parent's history at the fork boundary. Historical boundaries are reconstructed
from ordered archive cuts when the parent has compacted or reverted since.
Episode IDs stay stable; new IDs cannot
collide with inherited ones. Import happens on the fork event, with a retry on
first use, and survives parent deletion once complete. Ordinary subagents do
not inherit archives. A parent archive already lost before import cannot be
reconstructed by the plugin.

Writes are serialized by durable key across host contexts and hot reloads,
including episode counters, original tool calls, masks and fork imports.

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
  or generate a valid bounded handoff falls back to native compaction.
- The memory budget is checked against the entire rendered state. Invalid or
  oversized responses get at most one repair attempt; constraints are never
  truncated to make the budget pass. A native fallback is a reported exception
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

From a source checkout, run `npm test` with Node.js 22.18+ (tested with Node 26).
It builds the shipped entry before running the native TypeScript tests.

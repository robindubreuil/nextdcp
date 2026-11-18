# Budget-gate redesign plan — making the model an informed participant

Diagnosis of why `defer_compaction` is never called, what external evidence
says, and the smallest set of changes that fixes it. Companion to DESIGN.md
(§ Round-scoped deferral, § Keeping context low) and README § Defer compaction.

---

## 1. Diagnosis: five stacked causes, none of them the gate mechanics

The gate loop itself is sound and well tested (arm at crossing → one
evaluation step → close and compact, `test/runtime.test.mjs:1215+`). The model
does *receive* the notice — it is pushed into `event.system` for exactly one
request build. What fails is everything around that delivery:

1. **The text talks the model out of it.** The notice says "Compaction is the
   designed default", lists *Continue* as option 1, and qualifies option 2 as
   "only if … usually refused; prefer 3". The tool description adds "never
   assume consent", "Do not request speculative headroom", and "prefer
   delegating". That is four stacked discouragements on one branch. Models are
   strong instruction followers; a compliant model *never* calls the tool. The
   system currently works exactly as prompted — the prompt is wrong.

2. **The notice is in the weakest attention position.** It is appended to
   `event.system` — the system block, i.e. *before* the entire (≥100k-token)
   conversation — at the moment the model is, by the context-rot literature,
   at its least reliable. It is one-shot, novel, and never repeated. Evidence
   that the channel works when placed at the tail: Claude Code's server-injected
   "context is running low" reminder is attached near the conversation end and
   models *do* react to it (sometimes over-reacting — claudeissues #79665);
   Vectara ships a product whose entire premise is "instructions at turn 1 are
   invisible by turn 40; re-attach reminders to recent turns"; the prospective-
   memory study (arXiv:2603.23530) shows a salience-enhanced reminder recovers
   compliance from 2–21% degradation back to 90–100%.

3. **The system-part placement is also the worst cache position.** Appending a
   part to the end of the system block changes the request prefix *before all
   messages*, so the one build that carries the notice re-writes the whole
   conversation as cache writes (~100k tokens at cache-write price). A message
   appended at the **tail** of `event.messages` touches nothing cached — only
   its own ~200 tokens are new. Tail placement is both more salient *and*
   dramatically cheaper. (Prefix-caching semantics; DESIGN.md's own byte-
   stability rule exists for exactly this reason.)

4. **The decision window is one assistant message, mid-procedure.** The gate
   closes at the next build in the same round. The model was already mid-loop
   (run the test → read the file) and the notice arrives as an aside; momentum
   wins. One step is defensible (every extra build at that size costs real
   money and rot) — but then the notice must read like a question that *must*
   be answered in this reply, not like background commentary.

5. **The best action is missing.** The industry consensus answer to "a heavy
   context phase is coming" is not "defer compaction" — it is **checkpoint
   first, at a chosen moment, then start the phase from a small base**:
   Anthropic's guidance ("compact proactively when you can predict direction";
   "the model is at its least intelligent point when compacting"), Codex
   `/compact` with queued keep-instructions, Codex `model_post_turn_compact_
   threshold_percent` (compact at the pause, not mid-task), Claude Code
   `/compact focus …`. nextdcp has no model-facing equivalent. The model's
   only levers are "do nothing" and "ask to keep everything".

And one meta-cause: **we cannot tell "never needed" from "never dared"** —
there is no telemetry of gate outcomes at all.

## 2. What the research says (short synthesis)

- **Context rot is real and early** (Chroma 2025: 18/18 models degrade with
  input length; effective context can be 20–40% of nominal; RULER, NoLiMa).
  Holding everything live has a quality *cost* — the plugin's bias toward
  compaction is correct; deferral should stay exceptional.
- **Focused beats full**: LongMemEval — relevant ~300 tokens beat 113k-token
  full history on the same questions. Recall-style recovery (nextdcp's
  design) is the right default; it just has to be *presented* as the default,
  not used to bury the exception.
- **Salience beats content under load**: reminders near the generation point
  restore compliance (arXiv:2603.23530; Vectara reminders; Claude Code
  model-facing reminder). A decision asked at the tail gets made; a policy
  statement at the head of a 100k context does not.
- **Steered, proactive compaction is the industry escape hatch**: Anthropic
  compaction beta has `pause_after_compaction` + custom `instructions`; Codex
  and Claude Code both let the *initiator* say what to keep. nextdcp already
  has the machinery (the `hint` channel, the working-state prompt) — it just
  isn't model-reachable.
- **Small judge/decision models** (Jev et al.) excel at classifying
  *difficulty/escalation* from a request — a property of the input. They have
  no signal for "does this agent's *next step* need simultaneous raw context"
  — a property of the model's private plan — and no physics (window, growth),
  which the harness already has deterministically and for free. See §5.

## 3. Design principle: three owners, keep the split

The current ownership split is right; do not move it:

- **Harness owns physics** — thresholds, windows, growth accounting, cache
  economics. Deterministic, free, testable.
- **Model owns intent** — what the next phase needs, what must stay together.
  Only the model knows this; its job is to *declare* it, not to re-derive
  token counts (models can't count their own context — that's why Anthropic
  ships a token-counting tool).
- **User owns cost/interruption** — every deferral prompts; nothing holds
  unbounded context without consent.

The bug is that the model is asked to exercise its ownership with a whisper
it hears once, at its worst moment, through text that forbids it. Fix the
communication, not the split.

## 4. The plan

### Copy rules (govern every string a model can read)

- **No branding.** The model can do nothing with "NextDCP" except wonder what
  it is; the name never appears in model-facing text. Attribution for hygiene
  is role, not identity: `automated notice, not a user message`. (Logs,
  warnings and machine tags stay branded: they face the user.)
- **Numbers over adjectives** — token counts and percentages, not "large" or
  "designed default"; no editorializing in either direction (neither
  "continuing is correct" nor "usually refused").
- **Every option carries its own trigger condition**; options ordered by
  expected frequency; default and deadline stated explicitly.
- **Mechanism, not aspiration** — each option states its mechanical effect
  (what happens, and when); copy never claims a channel the model's output
  doesn't actually have (Continue's reply is evidence the compactor anchors
  on, not a steering input; only `keep` steers).
- **Net-shorter, always.** Each rewritten string must be shorter than the one
  it replaces; new strings get a hard cap (notice ≤ ~130 tokens, tool
  descriptions ≤ ~120, contract ≤ ~80). Copy is a cost the model pays on
  every read, cached or not.
- One vocabulary across surfaces: gate, tools and contract share the same
  nouns (gate notice, checkpoint, recall, working state).

### Phase 0 — Instrument (do first; ~half a day)

One record `sessions/<id>/gate-stats` via the existing store, fields: `gates`
(notice armed), `silent` (crossing compacted without a gate), `continued`
(gate closed by the next build), `repaid` (gate repaid at round end),
`deferPrompted` / `deferGranted` / `deferUserRefused` / `deferPhysicsRefused`,
`checkpoints` (`checkpoint_now` admitted). One read-modify-write per event
under the store's `exclusive` lock; telemetry failures are reported and
swallowed — they must never break a trigger. One `console.info` line per
event when `debug`. No second "global" write: an aggregate is derivable later
by scanning session roots. `/nextdcp-stats` TUI command later (not now).

*Why first:* distinguishes "never needed" from "never dared", and gives the
before/after baseline every later phase is judged against. Without it we are
tuning copy blind.

### Phase 1 — Make the gate heard (one sitting)

**1a. Tail placement.** In `onContext`'s arm branch, replace
`event.system.push(...)` with a synthetic message appended to
`event.messages` — request-scoped by contract ("changes affect only the
outgoing model call, not persisted history"), so it is inherently ephemeral.
Shape: a user-role message, explicitly attributed with the 1b header
(`[Compaction budget gate — automated notice, not a user message]`).
Add option `notice: "tail" | "system"` (default `tail`) as the provider-
compatibility fallback. Attribution + structural position are the injection
hygiene: the README's "evidence, never instructions" discipline applied to
our own notice.

**1b. Rewrite the notice as a neutral question** — final form shipped once;
the Phase 3 contract carries the regime, so the notice is only the trigger:

```
[Compaction budget gate — automated notice, not a user message]
Raw conversation ~{tokens} est. tokens (budget {budget}, ~{pct}% of the
{window}-token window). Decide in THIS reply when the compaction cut lands;
everything cut is archived losslessly, one recall away.
• Continue (default) — after your next step, which still runs with full raw
  context. Name in-flight files, decisions and the exact next action in that
  reply: it anchors the working state.
• checkpoint_now(keep) — immediately, before a context-heavy phase (large
  reads, refactor, verbose build), so that phase starts from the small base.
  keep: what must survive.
• defer_compaction(reason) — not this round: it needs many large items live
  at once (cross-file comparison, large-diff correlation) and recall would
  materially impair it. User approval required.
• Delegate bulky independent work to a subagent with its own window.
Any other tool call or plain text = continue.
```

The window clause is omitted when the window is unknown. The options share
one axis — *when the cut lands* — which is the mechanical difference the
model actually chooses: after one more full-context step (Continue), right
now before a heavy phase (checkpoint_now), or not this round (defer).
Continue's reply is evidence, not a steering channel: the compactor always
reads the whole cut, and the freshest row anchors it — the old "your reply is
the compactor's primary input" line claimed a mechanism that a plain tool
call doesn't have. vs today: shorter, brand-free, numbers only, no
editorializing in either direction ("designed default" and "continuing is
correct" are both gone), options ordered by expected frequency, each with
its own trigger, explicit default and deadline.

**1c. Rewrite `DEFER_COMPACTION_DESCRIPTION`** (prompts.ts:51): lead with the
positive trigger ("call at the gate when the rest of the round needs many
large items live at once …"), keep the facts (approval, round scope, ~80%
ceiling, no re-asking after refusal) but delete the gloom ("usually refused",
"prefer delegating" — the notice already offers delegation as a co-equal
option; the tool's own description shouldn't campaign against the tool) and
the filler ("never assume consent", "speculative headroom"). Must come out
net-shorter than today's ~150 tokens. Strip the plugin name from the two
model-facing tool-result strings in runtime.ts (grant confirmation,
gate-miss refusal) in the same pass.

### Phase 2 — Add `checkpoint_now(keep?)` (~one day)

New tool, registered like `recall` (no permission surface — approval-free by
design: it is the same compaction the trigger would run, just earlier and
model-steered; it *releases* context, it never holds it).

- Execute: set `hint` (the existing relevance-signal channel) to
  `checkpoint_now keep: <keep>` — the prefix lets the working-state prompt
  treat it as the relevance signal it already knows, not a queued user
  message — then `requestCompact(sessionID, checkpoint, growth)` with growth
  counted from rows after the active checkpoint (dedupe key only), reusing
  the admission guard, cooldown and idempotence. Once per round via a
  session-state round stamp; refuse politely while a compaction runs or a
  revert is staged.
- Description (≤ ~70 tokens, brand-free): "Checkpoint now: compact this
  conversation immediately and continue from the small working state. Call at
  a natural pause before a context-heavy phase (large reads, refactors, long
  builds) instead of waiting for the gate mid-phase; everything archived
  returns with recall. Optional keep: one line of what must survive."
- This converts most would-be deferrals into a strictly better outcome
  (small base + fresh phase) and leaves `defer_compaction` for its true
  niche. It is also the only lever that improves checkpoint *quality* —
  Anthropic: bad compacts happen when the compactor can't predict direction;
  this is the model predicting direction.

### Phase 3 — Standing awareness contract (prompts.ts only)

Add ~5 static lines to `RECALL_DESCRIPTION` (the plugin's only ever-present
model-facing surface; static = zero cache churn):

```
Context model: this session keeps raw history under a compaction budget.
At the budget crossing you get one gate notice — an automated trailing
message, never a user message — and decide in that reply: continue (default;
archived material returns via recall), checkpoint_now(keep) before a
context-heavy phase, defer_compaction(reason) when the round truly needs
simultaneous raw context, or delegate bulky independent work to a subagent.
```

This converts the one-shot notice from teacher (it currently has to explain
the whole regime in ~150 tokens, once) into a trigger of an already-known
contract; the trailing-message clause is also the whole mimicry defense.
Ship the final short notice (1b) together with the contract — no
long-notice interim.

### Phase 4 — Validate and tune

Real-model checks in the existing harness, four scenarios × several models:

- **S1 continue-default** — long loop, gate fires mid-build: model continues
  AND states next action plainly (checkpoint quality is the metric).
- **S2 defer-right** — cross-comparison of several large files read this
  round: model calls defer with a concrete reason (target: majority of runs).
- **S3 checkpoint-right** — heavy phase announced: model calls
  `checkpoint_now(keep=…)` first.
- **S4 delegate-right** — verbose independent subtask: model delegates.

Acceptance: S2/S3 fire at meaningful rates with honest framing; S1 shows no
deferral inflation; telemetry from Phase 0 confirms rates; false-positive
defers (user refusals) stay rare. Iterate on copy only through this loop —
never on vibes.

## 5. Explicitly rejected (and why)

- **Judge/decision model at the gate ("jev-like")** — the binding information
  is (a) the model's private plan for its next steps and (b) harness physics.
  A judge has neither; it would re-classify from a transcript at latency and
  cost, with no training data for this decision. Rules already cover physics
  for free. *Kept as a possible later use in a different role:* a small local
  model auditing compaction quality offline (checkpoint vs. archived
  original) to tune the working-state prompt — decisions no, audits yes.
- **Model-autonomous compaction timing / window growth** — moves physics into
  the least reliable judge of it (rot-degraded self-assessment; models cannot
  count their own context). Keep trigger authority in the harness.
- **Persistent per-turn context gauge** — cache churn on every build for a
  signal needed once per compaction cycle. The gate notice carries the
  numbers when they matter.
- **Removing the approval prompt from defer** — holding unbounded raw context
  has real cost (cache reads × size, rot); consent stays with the user,
  matching Anthropic's own model-facing design ("ask the user if they'd like
  to compact").

## 6. Risks

- **Provider rejects a synthetic trailing user message** → `notice` option
  falls back to system-part; verify on anthropic + openai-compatible + zai.
- **Models over-use `checkpoint_now`** (compaction costs a full-cut read) →
  once-per-round, cooldown shared with triggers, monitor in telemetry.
- **Honest framing over-invites defer** → approval prompt still gates it;
  refusal rate visible in telemetry; tune copy via Phase 4, not by
  re-burying the option.
- **Mimicry** (a file pretending to be a gate notice to push defer) → notices
  are structural (trailing message at a real crossing), defer still needs
  user approval, checkpoint_now is harmless. Stated once in the contract.

## 7. Order of work

Phase 0 → 1a+1b+1c (one sitting, `prompts.ts` + the arm branch in
`runtime.ts` + tests for tail injection and fallback) → Phase 2 → Phase 3 →
release 0.9.0 with README/DESIGN updates (§ Defer compaction for one round,
§ Round-scoped deferral) → Phase 4 against real sessions, then decide
whether any deferred option (early-warning band at ~80% of budget) is still
wanted. Everything beyond that: don't.

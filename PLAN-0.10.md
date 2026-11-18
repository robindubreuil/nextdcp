# 0.10 plan — measured lifetime memory

Three changes, one thesis: stop being a per-session garbage collector;
become a measured, lifetime memory system. Companion to GATE-PLAN.md
(whose gate/stats machinery this builds on) and DESIGN.md.

Grounding (Nov 2026): context rot is universal and early (Chroma 18/18
models) — the optimum cut is task-shaped, not a constant; plain searchable
text beats vector pipelines on agent memory (Letta filesystem > Mem0 on
LoCoMo); elision-with-archive is where providers are heading (Anthropic
context editing). All three changes reuse machinery nextdcp already has:
the validated handoff schema, gate stats, and the BM25 corpus.

---

## Phase 1 — Incremental handoffs (patch-mode generation)

**Problem.** Every cut regenerates the *entire* working state; output
tokens scale with state size on every compaction — most on exactly the
constraint-heavy tasks where cuts are frequent.

**Design.** When the prior working state is structured (`existing.working`),
the same prompt asks for a **patch**: identical JSON, but any `working`
field that is unchanged is *omitted*; a present field replaces the old one
entirely (lists wholesale). `archive` is always new (one note per episode);
`retiredConstraints` works exactly as today. `working.ts` grows a patch
parser/applier (~30 lines): validate the patch shape, apply onto the prior
state, then validate the **merged whole** through the same schema,
reference-id, and budget checks `parseHandoff` already runs. Any failure —
invalid patch, unknown reference, over-budget merge — falls back to the
existing full-generation loop (whose repair prompt already says "produce a
complete valid replacement, not a patch"). A full regen also prunes drift
carried by untouched fields.

**Why safe.** The committed artifact is always the same validated,
budget-checked `Handoff`; only the *request* shape changes. First cuts
(no structured prior) and repairs stay full-mode. Constraint retirement
keeps its exact-quote proof: patch mode does not touch that contract.

**Cost.** Happy path: one model call whose output is proportional to what
changed. Patch failure costs at most the old path's two attempts.

**Tests.** Patch apply/keep semantics; retirement validation on patches;
merged-over-budget → full fallback; runtime sends patch-mode prompt only
when a structured prior exists; invalid patch falls back to full regen.

## Phase 2 — Adaptive budget thermostat

**Problem.** The 100k budget is a constant. Heavy-recall sessions are
telling us the cut was too lossy; zero-recall sessions tell us it was too
early. Nobody ships the closed loop (Claude Code's threshold is static).

**Design.** Count recall executions per **cycle** (one committed checkpoint
to the next). A cycle ends when roughly one budget's worth of conversation
has passed, so recalls-per-cycle is naturally normalized — no pace math.
At each committed cut, fold the finished cycle's count into an EMA
(α = 0.5), persisted at `project/thermostat` **per main model**
(`provider/id`), shared by all sessions of the project. The effective
budget for a model = clamp(learned, bounds) where bounds are
`[30k, window × 0.5]`; the learned value starts at the static default,
`min(window × 0.5, 100k)`, and moves only when:

- **minimum evidence**: ≥ 4 completed cycles for that model, and
- **hysteresis**: EMA ≥ 2.0 → × 1.2 (lossy cuts: cut later, keep more);
  EMA ≤ 0.5 → × 0.9 (no recall pressure: cut earlier, less rot). One step
  per completed cycle at most.

`options.budget` (explicit) and unknown windows keep today's behavior —
the thermostat only ever adapts the auto budget. Adjustments log under
`debug`; the gate notice already prints the live budget number, so the
model sees the adapted value for free.

**Why safe.** Bounds cap the blast radius; evidence gates silence the
noise; an explicit user setting wins absolutely. Telemetry stays
fire-and-forget: a thermostat failure reports and falls back to the
default budget, never blocks a trigger or a cut.

**Tests.** Default holds below the evidence floor; EMA crossing a
threshold steps the budget inside bounds; explicit `options.budget`
disables; recall counter resets per cycle; subagent sessions never feed
the loop (they share the parent's model but not its cycles — counter is
per session runtime).

## Phase 3 — Project-lifetime archive (graduated notes)

**Problem.** Episodes die with the session. nextdcp owns the best memory
corpus in the business and erases it on delete; re-deriving "which flag
fixed the build three sessions ago" costs twenty tool calls.

**Design.** On `session.deleted`, **graduate** the session's episode notes
(Title + body, ≤ 120 words each) into a project-scoped store
(`project/episodes/P<n>`): note text, originating session id, episode end
time. Notes only — raw transcripts and calls die with the session; a
graduated record is a searchable *pointer to what happened*, never
fetchable raw evidence. Subagent sessions (parentID) are not graduated
(they flood; their findings return via the delegation summary anyway).
Duplicate notes (fork copies) dedup by exact text. The store caps at the
200 most recent notes.

`recall query` searches the current session first, then appends graduated
notes to the corpus as note documents with a provenance label (session,
age at adaptive precision) and a **recency boost** — a small
multiplicative prior (1 → 0 over ~a month of age) so fresh experience
outranks stale advice at equal term scores, without touching BM25 itself.
Hit lines say so: `- recall P7 (graduated session note, ses_abc, 3d ago):
…`. `recall P7` (opaque handle) fetches the whole note — it *is* the
original. `recall catalog` stays session-scoped; discovery is query-first.
RECALL_DESCRIPTION gains one sentence stating that queries also search
graduated notes and that their raw transcripts are gone.

**Why safe.** Archive stays evidence, never instructions (the standing
rule); age labels + recency prior answer stale advice; no new deps, no
embeddings — the same BM25 over ~200 short docs. Graduation failure never
blocks deletion.

**Tests.** Graduation on delete (labels, dedup, cap, subagent skip);
query surfaces graduated hits with label; recency boost ranks newer above
older at equal scores; `P<n>` fetch; fresh session sees project notes;
session catalog unchanged.

## Order and release

Phase 1 → 2 → 3 (each lands on the previous one's hardening), tests with
each phase, then 0.10.0: README/DESIGN sections, release, hot-reload,
dogfood. Copy rule throughout: every new model-facing string carries its
mechanism and stays under its cap (patch paragraph ≤ ~80 tokens, recall
addition ≤ ~50).

## Explicitly rejected

Vector/embedding search (deps; plain text wins the evidence), sleep-time
consolidation agents (off-path burn is burn), speculative background
summaries (triggers must never block on generation), graduating raw
transcripts on delete (unbounded; notes carry the pointer), per-request
budget re-planning (physics stays with the harness, per GATE-PLAN §3),
thermostat acting on anything but committed-cut evidence (gate stats
remain telemetry, never triggers, until they close this one loop).

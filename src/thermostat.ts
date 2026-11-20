import { object } from "./guards.ts"

// The adaptive budget thermostat, measured per completed compaction cycle.
// A cycle spans about one budget by construction, so the plant already
// integrates: the signal is durable tokens per assistant turn (how fast the
// live transcript grows) and the setpoint lives in turn space, where
// token-estimator bias cannot reach. The budget steps toward a cycle span of
// L_TARGET turns, never shorter than L_MIN. Defaults hold until evidence
// exists; an explicit options.budget or an unknown window keeps the static
// behavior (the caller's guard), and every failure falls back to the default —
// this is advisory, never load-bearing.

/** One model's learned state, persisted at `project/thermostat`. */
export type ThermostatEntry = {
  /** EMA of calibrated durable tokens per assistant turn. */
  readonly growth: number
  /** EMA of assistant turns per cycle: the measured cycle span. */
  readonly span: number
  readonly cycles: number
  readonly budget: number
}
export type ThermostatModels = Readonly<Record<string, ThermostatEntry>>

/** Setpoint in turn space: cycles aim at L_TARGET turns, never below L_MIN. */
export const L_MIN = 12, L_TARGET = 28
/** A measured recent growth rate at or above SPIKE times the learned rate is a
 *  rate spike: evidence the round's work is bulkier than the cycle integration
 *  can represent, held by the gate's spike guard rather than the budget. */
export const SPIKE = 2.0
/** Rate limit: the budget moves at most ±STEP of itself per completed cycle. */
export const STEP = 0.2
/** The learned budget never drops below this (or the start, on small windows). */
export const THERMOSTAT_FLOOR = 30_000
/** Context-rot ceiling: on current frontier models, measured quality holds to
 *  roughly 150k tokens of live context even on very large windows, and several
 *  providers start premium pricing at 200k — no window earns more than this. */
export const THERMOSTAT_CEILING = 150_000

export type BudgetBounds = { readonly floor: number; readonly start: number; readonly ceiling: number }

const clamp = (value: number, low: number, high: number): number => Math.min(high, Math.max(low, value))

/** Bounds for a known window: start at today's static default, hard-capped at
 *  min(half the window, the context-rot ceiling). */
export function budgetBounds(window: number, autoBudget: number): BudgetBounds {
  const ceiling = Math.min(window * 0.5, THERMOSTAT_CEILING)
  const start = Math.min(ceiling, autoBudget)
  return { floor: Math.min(THERMOSTAT_FLOOR, start), start, ceiling }
}

/** The effective trigger budget for a model: its learned budget, clamped to bounds. */
export function effectiveBudget(entry: ThermostatEntry | undefined, bounds: BudgetBounds): number {
  if (entry === undefined) return bounds.start
  return Math.min(bounds.ceiling, Math.max(bounds.floor, entry.budget))
}

/** Fold one completed cycle into the growth and span EMAs and step the budget
 *  toward the turn-space setpoint. `tokens` is the cycle's calibrated durable
 *  tokens, `turns` its assistant rows; one division yields the growth rate —
 *  no derivative, because the cycle already integrated it. A single freak
 *  cycle moves the budget at most one rate-limited step and half an EMA. */
export function closeCycle(entry: ThermostatEntry | undefined, tokens: number, turns: number, bounds: BudgetBounds): ThermostatEntry {
  if (!Number.isFinite(tokens) || tokens < 0) throw new Error("Invalid cycle token count")
  if (!Number.isSafeInteger(turns) || turns < 1) throw new Error("Invalid cycle turn count")
  const rate = tokens / turns
  const growth = entry === undefined ? rate : entry.growth * 0.5 + rate * 0.5
  const span = entry === undefined ? turns : entry.span * 0.5 + turns * 0.5
  const previous = entry?.budget ?? bounds.start
  // One rate-limited proportional step toward the setpoint budget g·L_TARGET…
  const target = clamp(growth * L_TARGET, previous * (1 - STEP), previous * (1 + STEP))
  // …then physics: no more often than every L_MIN turns when the growth is
  // known, but never pushed past the window's own ceiling — saturating there
  // is the gate's overWindow ask, not the budget's business.
  const lower = Math.min(Math.max(bounds.floor, growth * L_MIN), bounds.ceiling)
  return { growth, span, cycles: (entry?.cycles ?? 0) + 1, budget: Math.round(clamp(target, lower, bounds.ceiling)) }
}

/** The work's measured shape cannot fit the window: even at the ceiling-saturated
 *  budget, cycles run shorter than L_MIN turns. The gate notice then carries a
 *  user-facing ask instead of a silent deadlock. Judged on the measured span,
 *  never the predicted growth. */
export function overWindow(entry: ThermostatEntry | undefined, bounds: BudgetBounds): boolean {
  return entry !== undefined && entry.span < L_MIN && effectiveBudget(entry, bounds) >= bounds.ceiling
}

/** Tolerant read of a stored thermostat record: invalid whole records or entries
 *  are dropped, never thrown — a corrupt record must not break the trigger.
 *  Pre-turn-space records (recall-EMA keyed `ema`) drop whole: a fresh start
 *  is cheaper than mistranslating one signal into another. */
export function thermostatModels(value: unknown): ThermostatModels {
  if (value === undefined) return {}
  if (!object(value)) return {}
  const out: Record<string, ThermostatEntry> = {}
  for (const [model, entry] of Object.entries(value)) {
    if (!object(entry) || typeof entry.growth !== "number" || !Number.isFinite(entry.growth) || entry.growth < 0 ||
        typeof entry.span !== "number" || !Number.isFinite(entry.span) || entry.span <= 0 ||
        typeof entry.cycles !== "number" || !Number.isSafeInteger(entry.cycles) || entry.cycles < 0 ||
        typeof entry.budget !== "number" || !Number.isFinite(entry.budget) || entry.budget <= 0) continue
    out[model] = { growth: entry.growth, span: entry.span, cycles: entry.cycles, budget: entry.budget }
  }
  return out
}

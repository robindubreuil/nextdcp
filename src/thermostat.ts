import { object } from "./guards.ts"
import { DEFAULT_OUTPUT_RESERVE, REQUEST_MARGIN } from "./estimate.ts"

// Bounded fallback for overdue model-directed checkpoints, not a recommended
// checkpoint cadence or a measured context-rot boundary. Capacity is independent.

/** One model's learned state, persisted under its actual project ID. */
export type ThermostatEntry = {
  readonly version: typeof THERMOSTAT_VERSION
  /** EMA of calibrated routine durable tokens per assistant turn (no returned evidence). */
  readonly growth: number
  /** EMA of assistant turns per cycle: the measured cycle span. */
  readonly span: number
  readonly cycles: number
  readonly budget: number
}
export type ThermostatModels = Readonly<Record<string, ThermostatEntry>>

/** Version the policy, not just its JSON shape: old growth/demand budgets reseed. */
export const THERMOSTAT_VERSION = 2
export const SAFEGUARD_START = 200_000
/** Advisory rate target and short-cycle diagnostic; neither is a physical limit. */
export const L_MIN = 12, L_TARGET = 28
/** A measured recent growth rate at or above SPIKE times the learned rate is a
 *  rate spike. Only explicit growth-budget scheduling may hold that round;
 *  an overdue automatic safeguard must not be postponed this way. */
export const SPIKE = 2.0
/** Asymmetric rate limits per completed cycle, within the policy bounds. */
export const GROWTH_STEP = 0.5, REDUCTION_STEP = 0.2

export type BudgetBounds = { readonly floor: number; readonly start: number; readonly ceiling: number }

const clamp = (value: number, low: number, high: number): number => Math.min(high, Math.max(low, value))

/** Retained-conversation policy bounds: normally 150k–300k, starting at 200k.
 *  Smaller windows/input limits scale or clamp them down. Fixed overhead still
 *  belongs to the separate, authoritative complete-request capacity check. */
export function budgetBounds(window: number, outputReserve = DEFAULT_OUTPUT_RESERVE, inputLimit = Infinity): BudgetBounds {
  const capacity = Math.max(1, Math.floor(Math.min(window - outputReserve, inputLimit) - REQUEST_MARGIN))
  const start = Math.max(1, Math.floor(Math.min(capacity, window * 0.5, SAFEGUARD_START)))
  return { floor: Math.max(1, Math.ceil(start * 0.75)), start, ceiling: Math.min(capacity, Math.floor(start * 1.5)) }
}

/** The effective fallback threshold, clamped to policy/capacity bounds. */
export function effectiveBudget(entry: ThermostatEntry | undefined, bounds: BudgetBounds): number {
  if (entry === undefined) return bounds.start
  return Math.min(bounds.ceiling, Math.max(bounds.floor, entry.budget))
}

/** Fold routine growth rate and observed span into half-weight EMAs. The cycle's
 *  starting summary/tail is part of the retained-total target, not new growth.
 *  Temporary fresh-evidence headroom is separate and never learned here.
 *  Changed capacity bounds may still force an immediate clamp. */
export function closeCycle(entry: ThermostatEntry | undefined, tokens: number, turns: number, bounds: BudgetBounds, baseline: number): ThermostatEntry {
  if (!Number.isFinite(tokens) || tokens < 0) throw new Error("Invalid cycle token count")
  if (!Number.isSafeInteger(turns) || turns < 1) throw new Error("Invalid cycle turn count")
  if (!Number.isFinite(baseline) || baseline < 0) throw new Error("Invalid retained baseline")
  const rate = tokens / turns
  const growth = entry === undefined ? rate : entry.growth * 0.5 + rate * 0.5
  const span = entry === undefined ? turns : entry.span * 0.5 + turns * 0.5
  const previous = effectiveBudget(entry, bounds)
  const target = clamp(baseline + growth * L_TARGET, bounds.floor, bounds.ceiling)
  // Integer rounding must not move even half a token outside either step limit.
  const low = Math.max(bounds.floor, Math.ceil(previous * (1 - REDUCTION_STEP)))
  const high = Math.min(bounds.ceiling, Math.floor(previous * (1 + GROWTH_STEP)))
  return { version: THERMOSTAT_VERSION, growth, span, cycles: (entry?.cycles ?? 0) + 1, budget: clamp(Math.round(target), low, high) }
}

/** Short cycles at the upper POLICY bound; this does not establish that the work
 *  cannot fit the model's physical window. Judge measured span, not a prediction. */
export function shortCycles(entry: ThermostatEntry | undefined, bounds: BudgetBounds): boolean {
  return entry !== undefined && entry.span < L_MIN && effectiveBudget(entry, bounds) >= bounds.ceiling
}

/** Tolerant read of a stored thermostat record: invalid whole records or entries
 *  are dropped, never thrown — a corrupt record must not break the trigger.
 *  Unversioned growth/demand budgets drop whole: their units and permissive
 *  objective are incompatible with this bounded retained-conversation policy. */
export function thermostatModels(value: unknown): ThermostatModels {
  if (value === undefined) return {}
  if (!object(value)) return {}
  const out: Record<string, ThermostatEntry> = {}
  for (const [model, entry] of Object.entries(value)) {
    if (!object(entry) || entry.version !== THERMOSTAT_VERSION ||
        typeof entry.growth !== "number" || !Number.isFinite(entry.growth) || entry.growth < 0 ||
        typeof entry.span !== "number" || !Number.isFinite(entry.span) || entry.span <= 0 ||
        typeof entry.cycles !== "number" || !Number.isSafeInteger(entry.cycles) || entry.cycles < 0 ||
        typeof entry.budget !== "number" || !Number.isSafeInteger(entry.budget) || entry.budget <= 0) continue
    out[model] = { version: THERMOSTAT_VERSION, growth: entry.growth, span: entry.span, cycles: entry.cycles, budget: entry.budget }
  }
  return out
}

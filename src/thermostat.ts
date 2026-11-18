import { object } from "./guards.ts"

// The adaptive budget thermostat: recall pressure, measured per completed
// compaction cycle, moves the effective trigger budget for a project's model
// within physics bounds. Defaults hold until evidence exists; an explicit
// options.budget or an unknown window keeps the static behavior (the caller's
// guard), and every failure falls back to the default — this is advisory, never
// load-bearing.

/** One model's learned state, persisted at `project/thermostat`. */
export type ThermostatEntry = { readonly ema: number; readonly cycles: number; readonly budget: number }
export type ThermostatModels = Readonly<Record<string, ThermostatEntry>>

/** Evidence floor: no adjustment before this many completed cycles. */
export const MIN_CYCLES = 4
/** Recall-count EMAs at which the budget steps, and the steps themselves. */
export const RAISE_AT = 2.0, RAISE_BY = 1.2, LOWER_AT = 0.5, LOWER_BY = 0.9
/** The learned budget never drops below this (or the start, on small windows). */
export const THERMOSTAT_FLOOR = 30_000

export type BudgetBounds = { readonly floor: number; readonly start: number; readonly ceiling: number }

/** Bounds for a known window: start at today's static default, hard-capped at half the window. */
export function budgetBounds(window: number, autoBudget: number): BudgetBounds {
  const ceiling = window * 0.5
  const start = Math.min(ceiling, autoBudget)
  return { floor: Math.min(THERMOSTAT_FLOOR, start), start, ceiling }
}

/** The effective trigger budget for a model: its learned budget, clamped to bounds. */
export function effectiveBudget(entry: ThermostatEntry | undefined, bounds: BudgetBounds): number {
  if (entry === undefined) return bounds.start
  return Math.min(bounds.ceiling, Math.max(bounds.floor, entry.budget))
}

/** Fold one completed cycle's recall count into the EMA and step the budget at
 *  most once. A cycle is one committed checkpoint's worth of conversation, so
 *  recall counts are naturally normalized: every cycle spans about one budget. */
export function closeCycle(entry: ThermostatEntry | undefined, recalls: number, bounds: BudgetBounds): ThermostatEntry {
  if (!Number.isFinite(recalls) || recalls < 0) throw new Error("Invalid cycle recall count")
  const ema = entry === undefined ? recalls : entry.ema * 0.5 + recalls * 0.5
  const cycles = (entry?.cycles ?? 0) + 1
  let budget = entry?.budget ?? bounds.start
  if (cycles >= MIN_CYCLES) {
    if (ema >= RAISE_AT) budget *= RAISE_BY
    else if (ema <= LOWER_AT) budget *= LOWER_BY
  }
  return { ema, cycles, budget: Math.min(bounds.ceiling, Math.max(bounds.floor, Math.round(budget))) }
}

/** Tolerant read of a stored thermostat record: invalid whole records or entries
 *  are dropped, never thrown — a corrupt record must not break the trigger. */
export function thermostatModels(value: unknown): ThermostatModels {
  if (value === undefined) return {}
  if (!object(value)) return {}
  const out: Record<string, ThermostatEntry> = {}
  for (const [model, entry] of Object.entries(value)) {
    if (!object(entry) || typeof entry.ema !== "number" || !Number.isFinite(entry.ema) || entry.ema < 0 ||
        typeof entry.cycles !== "number" || !Number.isSafeInteger(entry.cycles) || entry.cycles < 0 ||
        typeof entry.budget !== "number" || !Number.isFinite(entry.budget) || entry.budget <= 0) continue
    out[model] = { ema: entry.ema, cycles: entry.cycles, budget: entry.budget }
  }
  return out
}

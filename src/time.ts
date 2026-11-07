/** Adaptive-precision time rendering for the archive. Pure and dependency-free. */

const SECOND = 1_000
const MINUTE = 60 * SECOND
const HOUR = 60 * MINUTE
const DAY = 24 * HOUR
const YEAR = 365 * DAY
const MONTH = YEAR / 12

/**
 * Compact elapsed duration at the two most-significant units, zero units dropped
 * (never a trailing zero unit).
 *
 * Rounding is truncation, never rounding up: every shown unit is floor() of its
 * true count, so a rendered duration never overstates the elapsed time
 * (59.9s -> `59s`, 14m 0.9s -> `14m`, a sub-second span -> `0s`).
 * Seconds appear below an hour only alongside minutes, hours below a day only
 * alongside days, etc.; the second unit is skipped when it truncates to zero.
 */
export function formatDuration(ms: number): string {
  if (!(ms > 0)) return "0s"
  if (ms < MINUTE) return `${Math.floor(ms / SECOND)}s`
  if (ms < HOUR) {
    const minutes = Math.floor(ms / MINUTE)
    const seconds = Math.floor((ms % MINUTE) / SECOND)
    return seconds > 0 ? `${minutes}m ${seconds}s` : `${minutes}m`
  }
  if (ms < DAY) {
    const hours = Math.floor(ms / HOUR)
    const minutes = Math.floor((ms % HOUR) / MINUTE)
    return minutes > 0 ? `${hours}h ${minutes}m` : `${hours}h`
  }
  if (ms < YEAR) {
    const days = Math.floor(ms / DAY)
    const hours = Math.floor((ms % DAY) / HOUR)
    return hours > 0 ? `${days}d ${hours}h` : `${days}d`
  }
  const years = Math.floor(ms / YEAR)
  const months = Math.floor((ms % YEAR) / MONTH)
  return months > 0 ? `${years}y ${months}mo` : `${years}y`
}

const pad = (value: number, width: number) => String(value).padStart(width, "0")

type Fields = { readonly year: string; readonly month: string; readonly day: string; readonly hour: string; readonly minute: string }

const fieldsOf = (ms: number): Fields => {
  const date = new Date(ms)
  return {
    year: pad(date.getFullYear(), 4),
    month: pad(date.getMonth() + 1, 2),
    day: pad(date.getDate(), 2),
    hour: pad(date.getHours(), 2),
    minute: pad(date.getMinutes(), 2),
  }
}

/**
 * One timestamp cascaded against an optional `reference` instant the surrounding
 * context already states: only the leading date fields the reference already
 * implies are omitted, while time is always shown. A standalone stamp (no
 * reference) re-anchors at full precision: `YYYY-MM-DD HH:MM`.
 */
export function formatStamp(ms: number, reference?: number): string {
  const fields = fieldsOf(ms)
  const time = `${fields.hour}:${fields.minute}`
  if (reference === undefined) return `${fields.year}-${fields.month}-${fields.day} ${time}`
  const ref = fieldsOf(reference)
  if (ref.year !== fields.year) return `${fields.year}-${fields.month}-${fields.day} ${time}`
  if (ref.month !== fields.month || ref.day !== fields.day) return `${fields.month}-${fields.day} ${time}`
  return time
}

/**
 * `from → to (duration)`. Both the field-set and the cascade are chosen by
 * elapsed = end - start: spans under a day keep `YYYY-MM-DD HH:MM`, spans under
 * a year drop the time (`YYYY-MM-DD`), and spans of a year or more keep the
 * year alone (`YYYY`). `from` renders at full precision within that set; `to`
 * cascades against `from` at group granularity (year / month-day / hour-minute):
 * leading groups `from` already states are omitted, cascading stops at the first
 * group that differs, and the final group is always kept.
 */
export function formatSpan(start: number, end: number): string {
  const elapsed = end - start
  const from = fieldsOf(start)
  const to = fieldsOf(end)
  const dateGroups: readonly ((fields: Fields) => string)[] = elapsed < YEAR
    ? [(fields) => fields.year, (fields) => `${fields.month}-${fields.day}`]
    : [(fields) => fields.year]
  const timeGroup = elapsed < DAY ? (fields: Fields) => `${fields.hour}:${fields.minute}` : null
  const groups = timeGroup ? [...dateGroups, timeGroup] : dateGroups
  const left = groups.map((group) => group(from))
  const right = groups.map((group) => group(to))
  let keep = 0
  while (keep < left.length - 1 && left[keep] === right[keep]) keep++
  const render = (values: readonly string[], skip: number) => {
    const date = values.slice(skip, dateGroups.length).join("-")
    const time = timeGroup ? values[values.length - 1] : ""
    return date ? (time ? `${date} ${time}` : date) : time
  }
  return `${render(left, 0)} → ${render(right, keep)} (${formatDuration(elapsed)})`
}

import assert from "node:assert/strict"
import test from "node:test"
import { formatDuration, formatSpan, formatStamp } from "../src/time.ts"

// Pin the process timezone: the expected strings read local time back exactly as
// the timestamps were constructed, and calendar spans (2026-10-02 -> 2026-11-03
// is exactly 32 days) must also be exact in milliseconds — a DST transition
// inside the span would otherwise stretch the elapsed time by an hour.
process.env.TZ = "UTC"

test("the suite runs at a fixed UTC offset so calendar spans are exact in milliseconds", () => {
  assert.equal(new Date().getTimezoneOffset(), 0)
  assert.equal(new Date(2026, 10, 3).getTime() - new Date(2026, 9, 2).getTime(), 32 * 86_400_000)
})

test("formatDuration renders the two most-significant units and drops zero units", () => {
  assert.equal(formatDuration(0), "0s")
  assert.equal(formatDuration(-5), "0s")
  assert.equal(formatDuration(42_000), "42s")
  assert.equal(formatDuration(1_999), "1s") // truncation, never rounding up
  assert.equal(formatDuration(59_999), "59s")
  assert.equal(formatDuration(60_000), "1m")
  assert.equal(formatDuration(840_000), "14m")
  assert.equal(formatDuration(845_000), "14m 5s")
  assert.equal(formatDuration(3_599_999), "59m 59s")
  assert.equal(formatDuration(3_600_000), "1h")
  assert.equal(formatDuration(18_180_000), "5h 3m")
  assert.equal(formatDuration(52_320_000), "14h 32m")
  assert.equal(formatDuration(50_400_000), "14h")
  assert.equal(formatDuration(50_459_000), "14h") // trailing zero minute dropped
  assert.equal(formatDuration(86_400_000), "1d")
  assert.equal(formatDuration(2_764_800_000), "32d")
  assert.equal(formatDuration(2_779_200_000), "32d 4h")
  assert.equal(formatDuration(31_532_400_000), "364d 23h")
  assert.equal(formatDuration(31_536_000_000), "1y")
  assert.equal(formatDuration(63_072_000_000), "2y")
  assert.equal(formatDuration(70_956_000_000), "2y 3mo")
  assert.equal(formatDuration(60_444_000_000), "1y 11mo")
})

test("formatStamp cascades against the reference instant and re-anchors standalone", () => {
  const standalone = new Date(2027, 0, 2, 9, 12).getTime()
  const sameYear = new Date(2027, 5, 1, 8, 0).getTime()
  const sameMonthOtherDay = new Date(2027, 10, 2, 9, 0).getTime()
  const sameDay = new Date(2027, 10, 3, 9, 0).getTime()
  const pastYear = new Date(2026, 10, 3, 9, 0).getTime()
  const afternoon = new Date(2027, 10, 3, 14, 30).getTime()
  // no reference: standalone fetch re-anchors at full precision
  assert.equal(formatStamp(standalone), "2027-01-02 09:12")
  // different year from the reference: full precision again
  assert.equal(formatStamp(standalone, pastYear), "2027-01-02 09:12")
  // same year: only the year is implied
  assert.equal(formatStamp(afternoon, sameYear), "11-03 14:30")
  // same year and month but a different day: the date is still shown
  assert.equal(formatStamp(afternoon, sameMonthOtherDay), "11-03 14:30")
  // same year, month, and day: only time remains
  assert.equal(formatStamp(afternoon, sameDay), "14:30")
  // fields are zero-padded to width
  assert.equal(formatStamp(new Date(2027, 0, 2, 9, 5).getTime()), "2027-01-02 09:05")
})

test("formatSpan picks fields by elapsed and cascades the end against the start", () => {
  // same day, 14h32m elapsed: time fields, end cascaded to the time
  assert.equal(
    formatSpan(new Date(2026, 10, 3, 9, 0).getTime(), new Date(2026, 10, 3, 23, 32).getTime()),
    "2026-11-03 09:00 → 23:32 (14h 32m)",
  )
  // crosses midnight but under a day: the end keeps its differing day and beyond
  assert.equal(
    formatSpan(new Date(2026, 10, 3, 22, 0).getTime(), new Date(2026, 10, 4, 1, 30).getTime()),
    "2026-11-03 22:00 → 11-04 01:30 (3h 30m)",
  )
  // 32 days: date fields, time dropped, end cascaded past the shared year
  assert.equal(
    formatSpan(new Date(2026, 9, 2).getTime(), new Date(2026, 10, 3).getTime()),
    "2026-10-02 → 11-03 (32d)",
  )
  // multi-year: year fields only
  assert.equal(
    formatSpan(new Date(2024, 8, 15).getTime(), new Date(2026, 11, 20).getTime()),
    "2024 → 2026 (2y 3mo)",
  )
  // cross-year but only 6 days: date fields, cascading stops at the differing year
  assert.equal(
    formatSpan(new Date(2026, 11, 30).getTime(), new Date(2027, 0, 5).getTime()),
    "2026-12-30 → 2027-01-05 (6d)",
  )
})

test("formatSpan field-set boundaries and a zero-length span", () => {
  // exactly one day: time is already dropped
  assert.equal(
    formatSpan(new Date(2026, 10, 3, 0, 0).getTime(), new Date(2026, 10, 4, 0, 0).getTime()),
    "2026-11-03 → 11-04 (1d)",
  )
  // exactly one year: year fields only
  assert.equal(
    formatSpan(new Date(2025, 10, 3).getTime(), new Date(2026, 10, 3).getTime()),
    "2025 → 2026 (1y)",
  )
  // zero elapsed: the end keeps its final group so it is never empty
  assert.equal(
    formatSpan(new Date(2026, 10, 3, 9, 0).getTime(), new Date(2026, 10, 3, 9, 0).getTime()),
    "2026-11-03 09:00 → 09:00 (0s)",
  )
})

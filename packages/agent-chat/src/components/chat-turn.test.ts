import assert from 'node:assert/strict'
import test from 'node:test'

import { formatSentAt } from './chat-turn'

// ---------------------------------------------------------------------------
// formatSentAt -- which side of the day boundary an instant falls on, and so
// whether its rendering carries a date at all.
//
// The boundary is the CALENDAR day and not a 24-hour window, which is the
// whole reason this needs pinning: the two agree almost always and disagree
// exactly where it matters. A minute either side of midnight is a day apart
// and must be dated; twenty hours inside one day is not and must not be.
//
// The expectations are built from the same locale the function formats in,
// rather than written out as literal strings, so what is asserted is the
// BRANCH taken -- dated or bare -- and not the host's date format. A test
// that hard-coded "Aug 25 09:05" would pass or fail on the runner's locale
// and timezone, which is not the behaviour under test.
// ---------------------------------------------------------------------------

const clock = (at: Date) => at.toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit' })
const withDate = (at: Date) => `${at.toLocaleDateString(undefined, { month: 'short', day: 'numeric' })} ${clock(at)}`

// Constructed from local-time parts because the same-day decision reads local
// calendar fields -- a UTC-built date would move the boundary by the offset.
const local = (year: number, month: number, day: number, hour: number, minute: number) =>
  new Date(year, month - 1, day, hour, minute)

test('a message sent today reads as a bare clock time', () => {
  const at = local(2026, 8, 25, 9, 5)
  const now = local(2026, 8, 25, 17, 40)
  assert.equal(formatSentAt(at, now), clock(at))
})

test('the whole of a day is still today, however far apart the two instants are', () => {
  // Just past midnight, read just before the next one: nearly 24 hours, one
  // calendar day. A 24-hour-window implementation dates this one.
  const at = local(2026, 8, 25, 0, 1)
  const now = local(2026, 8, 25, 23, 59)
  assert.equal(formatSentAt(at, now), clock(at))
})

test('one minute across midnight is a day ago and carries its date', () => {
  // The converse of the case above, and the one a 24-hour window gets wrong
  // in the other direction: two minutes apart, but not the same day.
  const at = local(2026, 8, 25, 23, 59)
  const now = local(2026, 8, 26, 0, 1)
  assert.equal(formatSentAt(at, now), withDate(at))
})

test('the same date in an earlier month is not today', () => {
  // Guards a same-day check that compares the day of the month and forgets
  // the month.
  const at = local(2026, 7, 25, 9, 5)
  const now = local(2026, 8, 25, 9, 5)
  assert.equal(formatSentAt(at, now), withDate(at))
})

test('the same date a year earlier is not today', () => {
  // Guards the same check forgetting the year -- the one that stays hidden
  // for twelve months and then renders a year-old message as if it just
  // arrived.
  const at = local(2025, 8, 25, 9, 5)
  const now = local(2026, 8, 25, 9, 5)
  assert.equal(formatSentAt(at, now), withDate(at))
})

test('the dated form is the bare form plus a date, never a replacement for it', () => {
  // The time of day survives crossing the boundary: a dated message still
  // says when in that day it was sent.
  const at = local(2026, 8, 25, 9, 5)
  const now = local(2026, 8, 26, 9, 5)
  assert.ok(formatSentAt(at, now).endsWith(clock(at)))
})

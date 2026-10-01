import assert from 'node:assert/strict'
import test from 'node:test'

import { isSponsorPromptDue } from '@/app/_shell/sponsor'

// Local-time constructors on both sides, so the month boundary is the one the
// rule uses whatever time zone the suite runs in.
const midMarch = new Date(2031, 2, 14, 12, 0)

test('a prompt never seen is due', () => {
  assert.equal(isSponsorPromptDue(null, midMarch), true)
  assert.equal(isSponsorPromptDue(undefined, midMarch), true)
})

test('a prompt seen earlier this month is not due again', () => {
  assert.equal(isSponsorPromptDue(new Date(2031, 2, 1, 0, 0), midMarch), false, 'the first instant of the month')
  assert.equal(isSponsorPromptDue(new Date(2031, 2, 14, 11, 59), midMarch), false)
})

test('a prompt last seen in an earlier month is due, however recently', () => {
  assert.equal(isSponsorPromptDue(new Date(2031, 1, 28, 23, 59), midMarch), true, 'the last minute of the month before')
  assert.equal(isSponsorPromptDue(new Date(2030, 2, 20), midMarch), true, 'the same month a year earlier')
})

test('a date that arrives as text is read the same as a Date', () => {
  // The session carries the stored date over JSON.
  assert.equal(isSponsorPromptDue(new Date(2031, 2, 2).toISOString(), midMarch), false)
  assert.equal(isSponsorPromptDue(new Date(2031, 1, 2).toISOString(), midMarch), true)
})

test('an unreadable stored value counts as never seen', () => {
  assert.equal(isSponsorPromptDue('not a date', midMarch), true)
})

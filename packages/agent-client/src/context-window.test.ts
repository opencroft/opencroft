import assert from 'node:assert/strict'
import test from 'node:test'

import { contextWindow, reportedContextWindow } from './context-window'

// ── contextWindow ────────────────────────────────────────────────────────────
//
// A name-substring guess. These pin the mapping so a change to it is a
// deliberate act rather than a side effect, NOT because the numbers are right —
// the module says plainly that they cannot be made right by editing.

test('a known family maps to its guessed window', () => {
  assert.equal(contextWindow('gemini-2.5-pro'), 1_000_000)
})

test('an unrecognised model is unknown rather than some default', () => {
  assert.equal(contextWindow('some-model-nobody-listed'), 0)
})

test('the match is case-insensitive, since model ids arrive in any casing', () => {
  assert.equal(contextWindow('GPT-4-Turbo'), 128_000)
})

// ── reportedContextWindow ────────────────────────────────────────────────────

test('a guess the conversation fits inside is reported as-is', () => {
  assert.equal(reportedContextWindow('gemini-2.5-pro', 12_000), 1_000_000)
})

// The reported defect: a session held ~601k tokens while the guess for its
// model family said 200k, and the pair was published as fact — a meter reading
// three times full, which then fed compaction decisions.
test('a guess the conversation has already exceeded is withheld, not reported', () => {
  assert.equal(reportedContextWindow('claude-sonnet-4', 601_216), 0)
})

// Withheld, not clamped. Clamping would still assert a capacity nobody
// established — it would merely make the lie internally consistent.
test('the exceeded guess is not clamped down to the used figure either', () => {
  const reported = reportedContextWindow('claude-sonnet-4', 601_216)
  assert.notEqual(reported, 601_216)
  assert.equal(reported, 0)
})

// Exactly at the boundary the window still holds: `used === size` is a full
// context, not an impossible one.
test('a conversation exactly filling the guess still reports it', () => {
  assert.equal(reportedContextWindow('claude-sonnet-4', 200_000), 200_000)
})

test('one token past the guess withholds it', () => {
  assert.equal(reportedContextWindow('claude-sonnet-4', 200_001), 0)
})

// An unknown window cannot be exceeded — there is nothing to contradict, and
// the answer stays unknown rather than becoming a different kind of unknown.
test('an unrecognised model stays unknown however much is held', () => {
  assert.equal(reportedContextWindow('some-model-nobody-listed', 900_000), 0)
})

// The flip that made the original report look like corruption: the window is
// re-derived from the model NAME on every report, so switching a session's
// model mid-conversation changes it while the tokens held carry on. Both
// readings below are individually honest; neither claims to hold more than fits.
test('switching model mid-session re-derives the window, and neither reading is impossible', () => {
  const held = 464_399
  assert.equal(reportedContextWindow('gemini-2.5-pro', held), 1_000_000)
  assert.equal(reportedContextWindow('claude-sonnet-4', held), 0)
})

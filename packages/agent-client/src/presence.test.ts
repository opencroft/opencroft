// The reading-cadence rule, tested where it is decided.
//
// All of it is arithmetic over a queue and a setting, which is why it lives
// apart from the engine: these run without a session, a connection or a clock.
import assert from 'node:assert/strict'
import test from 'node:test'

import {
  DEFAULT_PRESENCE,
  MINUTES_WINDOW_MAX_MS,
  MINUTES_WINDOW_MIN_MS,
  msUntilDue,
  oldestMessageAt,
  presenceWindowMs,
} from './presence'
import type { QueuedPrompt } from './types'

const T0 = Date.parse('2026-01-01T00:00:00.000Z')

function message(text: string, at: number): QueuedPrompt {
  return { id: text, kind: 'message', sender: 'Reader', sentAt: new Date(at).toISOString(), text }
}

function command(text: string): QueuedPrompt {
  return { id: text, kind: 'system', text }
}

test('the default is realtime, so a new setting changes nothing that did not ask', () => {
  assert.deepEqual(DEFAULT_PRESENCE, { kind: 'realtime' })
  assert.equal(presenceWindowMs(DEFAULT_PRESENCE), 0)
})

test('the fixed cadences are the intervals they are named for', () => {
  assert.equal(presenceWindowMs({ kind: 'hourly' }), 60 * 60_000)
  assert.equal(presenceWindowMs({ kind: 'daily' }), 24 * 60 * 60_000)
  assert.equal(presenceWindowMs({ kind: 'custom', intervalMs: 4_500 }), 4_500)
})

test('turn-based opens no window: the turn gate holds it, never a wait after', () => {
  // Zero means "due at the next boundary the engine consults" — idle now,
  // or the running turn's own end. A window here would ADD a wait after the
  // turn ended, which is not what the cadence promises.
  assert.equal(presenceWindowMs({ kind: 'turn-based' }), 0)
})

test('minutes lands inside its range at both ends of the roll', () => {
  assert.equal(presenceWindowMs({ kind: 'minutes' }, () => 0), MINUTES_WINDOW_MIN_MS)
  assert.equal(presenceWindowMs({ kind: 'minutes' }, () => 1), MINUTES_WINDOW_MAX_MS)
  const middle = presenceWindowMs({ kind: 'minutes' }, () => 0.5)
  assert.ok(middle > MINUTES_WINDOW_MIN_MS && middle < MINUTES_WINDOW_MAX_MS, String(middle))
})

test('a negative custom interval means no waiting, not a message that never arrives', () => {
  // Clamped rather than rejected: a bad setting should deliver early, never
  // hold somebody's message back forever.
  assert.equal(presenceWindowMs({ kind: 'custom', intervalMs: -1 }), 0)
})

test('the window is measured from the OLDEST message, not the newest', () => {
  // Measuring from the newest would let a steady trickle hold the queue shut
  // indefinitely — the opposite of what a reading cadence is for.
  const queue = [message('first', T0), message('second', T0 + 30_000), message('third', T0 + 59_000)]
  assert.equal(oldestMessageAt(queue), T0)
  assert.equal(msUntilDue(queue, 60_000, T0 + 59_000), 1_000)
})

test('a command does not open a window, and is not one to wait for', () => {
  // Presence gates conversation, not plumbing: compaction asked for now must
  // not wait an hour because the reading cadence is hourly.
  assert.equal(oldestMessageAt([command('/compact')]), null)
  assert.equal(msUntilDue([command('/compact')], 60_000, T0), null)
})

test('a command mixed in is ignored; the messages still decide', () => {
  const queue = [command('/compact'), message('hello', T0)]
  assert.equal(oldestMessageAt(queue), T0)
  assert.equal(msUntilDue(queue, 60_000, T0 + 60_000), 0)
})

test('due means zero, never a negative remainder', () => {
  // The caller arms a timer with this, and setTimeout treats a negative delay
  // as zero anyway — but a negative here would read as "overdue by", which is
  // not a thing any caller wants to have to interpret.
  assert.equal(msUntilDue([message('hello', T0)], 60_000, T0 + 500_000), 0)
})

test('realtime is due the instant it is asked', () => {
  assert.equal(msUntilDue([message('hello', T0)], 0, T0), 0)
})

test('an unreadable send time delivers early rather than waiting a day', () => {
  // A message whose time cannot be read is still a message somebody sent. The
  // safe direction for a bad value is too early, never held back.
  const broken: QueuedPrompt = { id: 'x', kind: 'message', sender: 'Reader', sentAt: 'not a date', text: 'x' }
  assert.equal(oldestMessageAt([broken]), 0)
  assert.equal(msUntilDue([broken], 60_000, T0), 0)
})

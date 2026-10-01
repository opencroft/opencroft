import assert from 'node:assert/strict'
import test from 'node:test'

import { deriveSessionStatus, type SessionActivitySets } from './session-status'

const NONE = new Set<string>()
const KEY = new Set(['k'])

/** No activity at all, overridden per test by the sets that hold the key. */
function sets(held: Partial<SessionActivitySets>): SessionActivitySets {
  return { pending: NONE, active: NONE, background: NONE, queued: NONE, alive: NONE, ...held }
}

test('offline when the key is in none of the sets', () => {
  assert.equal(deriveSessionStatus('k', sets({})), 'offline')
})

test('idle when alive but not active, pending, delegating or holding a queue', () => {
  assert.equal(deriveSessionStatus('k', sets({ alive: KEY })), 'idle')
})

test('working when active (and alive)', () => {
  assert.equal(deriveSessionStatus('k', sets({ active: KEY, alive: KEY })), 'working')
})

test('working when only background work is live — a delegation with no open turn is not idle', () => {
  // This is what keeps the idle reaper (which reads this status) off a session
  // whose own turn is over but whose subagents are still out.
  assert.equal(deriveSessionStatus('k', sets({ background: KEY, alive: KEY })), 'working')
})

test('queued when alive with messages held and no turn running', () => {
  assert.equal(deriveSessionStatus('k', sets({ queued: KEY, alive: KEY })), 'queued')
})

test('working takes priority over queued — a running turn’s queue is its next turn', () => {
  assert.equal(deriveSessionStatus('k', sets({ active: KEY, queued: KEY, alive: KEY })), 'working')
})

test('waiting when pending (and alive)', () => {
  assert.equal(deriveSessionStatus('k', sets({ pending: KEY, alive: KEY })), 'waiting')
})

test('waiting takes priority over every other state when all are set', () => {
  assert.equal(
    deriveSessionStatus('k', sets({ pending: KEY, active: KEY, background: KEY, queued: KEY, alive: KEY })),
    'waiting',
  )
})

test('a different key is unaffected by another key being pending/active/queued/alive', () => {
  assert.equal(
    deriveSessionStatus('other', sets({ pending: KEY, active: KEY, background: KEY, queued: KEY, alive: KEY })),
    'offline',
  )
})

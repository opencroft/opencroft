// Who holds a local extension folder. Every rule lives in a pure decision
// function, so the cases below are the contract itself rather than a test of
// the store underneath it: the persistence around it only reads the map and
// writes it back under the settings mutex and compare-and-swap.

import assert from 'node:assert/strict'
import test from 'node:test'

import {
  decideExtensionLock,
  type ExtensionLock,
  type ExtensionLockMap,
  extensionLockRefusalMessage,
  LOCK_IDLE_MS,
} from './extension-lock'

const NOW = 1_000_000_000
const MINUTE = 60_000
const FOLDER = 'local.some-extension'

function heldBy(agent: string, sinceMinutes: number, lastWriteMinutes = sinceMinutes): ExtensionLockMap {
  return {
    [FOLDER]: {
      agent,
      takenAt: NOW - sinceMinutes * MINUTE,
      lastTouched: NOW - lastWriteMinutes * MINUTE,
    },
  }
}

/** Asserts something was written before reading it, so a null map fails loudly. */
function lockOf(map: ExtensionLockMap | null, folder = FOLDER): ExtensionLock {
  assert.ok(map, 'expected a lock map to have been written')
  return map[folder]
}

test('an unheld folder is taken by the first writer', () => {
  const { decision, next } = decideExtensionLock({}, FOLDER, 'first', NOW)
  assert.equal(decision.outcome, 'taken')
  assert.equal(decision.lock.agent, 'first')
  assert.equal(lockOf(next).lastTouched, NOW)
})

test('the holder writing again refreshes the idle clock without restarting the lock', () => {
  const existing = heldBy('first', 10)
  const { decision, next } = decideExtensionLock(existing, FOLDER, 'first', NOW)
  assert.equal(decision.outcome, 'refreshed')
  assert.equal(lockOf(next).takenAt, existing[FOLDER].takenAt, 'still the same lock, not a new one')
  assert.equal(lockOf(next).lastTouched, NOW)
})

test('a second writer is refused while the holder is active', () => {
  const { decision, next } = decideExtensionLock(heldBy('first', 5), FOLDER, 'second', NOW)
  assert.equal(decision.outcome, 'refused')
  assert.equal(decision.lock.agent, 'first', 'the refusal carries who to ask, not who was refused')
  assert.equal(next, null)
})

test('a refusal does not extend the lock that refused it', () => {
  // Otherwise a blocked writer retrying keeps the folder held forever, and it
  // can never lapse while anyone is still trying to use it.
  const before = heldBy('first', 5)
  const { next } = decideExtensionLock(before, FOLDER, 'second', NOW)
  assert.equal(next, null, 'nothing is written at all on a refusal')
})

test('a lock nobody has written to for long enough is taken without ceremony', () => {
  const stale = heldBy('first', 120, LOCK_IDLE_MS / MINUTE + 1)
  const { decision } = decideExtensionLock(stale, FOLDER, 'second', NOW)
  assert.equal(decision.outcome, 'expired-taken')
  assert.equal(decision.lock.agent, 'second')
})

test('the expiry boundary belongs to the taker', () => {
  const exactly = heldBy('first', 60, LOCK_IDLE_MS / MINUTE)
  assert.equal(decideExtensionLock(exactly, FOLDER, 'second', NOW).decision.outcome, 'expired-taken')

  const justUnder = heldBy('first', 60, LOCK_IDLE_MS / MINUTE)
  justUnder[FOLDER] = { ...justUnder[FOLDER], lastTouched: NOW - LOCK_IDLE_MS + 1 }
  assert.equal(decideExtensionLock(justUnder, FOLDER, 'second', NOW).decision.outcome, 'refused')
})

test('takeover always works, however fresh the lock', () => {
  // The escape hatch has no conditions on purpose: a claim that can strand
  // somebody is worse than no claim at all.
  const { decision, next } = decideExtensionLock(heldBy('first', 0, 0), FOLDER, 'second', NOW, { takeover: true })
  assert.equal(decision.outcome, 'taken-over')
  assert.equal(lockOf(next).agent, 'second')
})

test('a claim on one folder says nothing about another', () => {
  const { decision, next } = decideExtensionLock(heldBy('first', 1), 'local.other-extension', 'second', NOW)
  assert.equal(decision.outcome, 'taken')
  assert.equal(lockOf(next, FOLDER).agent, 'first', 'the untouched folder keeps its holder')
  assert.equal(lockOf(next, 'local.other-extension').agent, 'second')
})

test('the idle window is configurable so callers are not forced onto the default', () => {
  const held = heldBy('first', 5, 5)
  assert.equal(decideExtensionLock(held, FOLDER, 'second', NOW, { idleMs: MINUTE }).decision.outcome, 'expired-taken')
})

test('the refusal message names the holder, the wait, and the way out', () => {
  const message = extensionLockRefusalMessage(FOLDER, heldBy('first', 12, 3)[FOLDER], NOW, 'do the thing')
  assert.match(message, /first/)
  assert.match(message, /12 min/)
  assert.match(message, /3 min/)
  assert.match(message, /do the thing/)
  assert.match(message, /advisory/i)
  assert.match(message, /local\.some-extension/)
})

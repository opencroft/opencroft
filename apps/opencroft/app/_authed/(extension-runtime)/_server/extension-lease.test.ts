// Who holds a shared extension folder. Every rule lives in a pure decision
// function, so the cases below are the contract itself rather than a test of
// the store underneath it: the persistence around it only reads the map and
// writes it back under the settings mutex and compare-and-swap.

import assert from 'node:assert/strict'
import test from 'node:test'

import { decideLease, type ExtensionLease, LEASE_IDLE_MS, type LeaseMap, leaseRefusalMessage } from './extension-lease'

const NOW = 1_000_000_000
const MINUTE = 60_000

function heldBy(agent: string, sinceMinutes: number, lastWriteMinutes = sinceMinutes): LeaseMap {
  return {
    'some-extension': {
      agent,
      takenAt: NOW - sinceMinutes * MINUTE,
      lastTouched: NOW - lastWriteMinutes * MINUTE,
    },
  }
}

/** Asserts something was written before reading it, so a null map fails loudly. */
function lease(map: LeaseMap | null, slug = 'some-extension'): ExtensionLease {
  assert.ok(map, 'expected a lease map to have been written')
  return map[slug]
}

test('an unheld folder is taken by the first writer', () => {
  const { decision, next } = decideLease({}, 'some-extension', 'first', NOW)
  assert.equal(decision.outcome, 'taken')
  assert.equal(decision.lease.agent, 'first')
  assert.equal(lease(next).lastTouched, NOW)
})

test('the holder writing again refreshes the idle clock without restarting the lease', () => {
  const existing = heldBy('first', 10)
  const { decision, next } = decideLease(existing, 'some-extension', 'first', NOW)
  assert.equal(decision.outcome, 'refreshed')
  assert.equal(lease(next).takenAt, existing['some-extension'].takenAt, 'still the same lease, not a new one')
  assert.equal(lease(next).lastTouched, NOW)
})

test('a second writer is refused while the holder is active', () => {
  const { decision, next } = decideLease(heldBy('first', 5), 'some-extension', 'second', NOW)
  assert.equal(decision.outcome, 'refused')
  assert.equal(decision.lease.agent, 'first', 'the refusal carries who to ask, not who was refused')
  assert.equal(next, null)
})

test('a refusal does not extend the lease that refused it', () => {
  // Otherwise a blocked writer retrying keeps the folder held forever, and it
  // can never lapse while anyone is still trying to use it.
  const before = heldBy('first', 5)
  const { next } = decideLease(before, 'some-extension', 'second', NOW)
  assert.equal(next, null, 'nothing is written at all on a refusal')
})

test('a lease nobody has written to for long enough is taken without ceremony', () => {
  const stale = heldBy('first', 120, LEASE_IDLE_MS / MINUTE + 1)
  const { decision } = decideLease(stale, 'some-extension', 'second', NOW)
  assert.equal(decision.outcome, 'expired-taken')
  assert.equal(decision.lease.agent, 'second')
})

test('the expiry boundary belongs to the taker', () => {
  const exactly = heldBy('first', 60, LEASE_IDLE_MS / MINUTE)
  assert.equal(decideLease(exactly, 'some-extension', 'second', NOW).decision.outcome, 'expired-taken')

  const justUnder = { ...heldBy('first', 60, LEASE_IDLE_MS / MINUTE) }
  justUnder['some-extension'] = { ...justUnder['some-extension'], lastTouched: NOW - LEASE_IDLE_MS + 1 }
  assert.equal(decideLease(justUnder, 'some-extension', 'second', NOW).decision.outcome, 'refused')
})

test('takeover always works, however fresh the lease', () => {
  // The escape hatch has no conditions on purpose: a claim that can strand
  // somebody is worse than no claim at all.
  const { decision, next } = decideLease(heldBy('first', 0, 0), 'some-extension', 'second', NOW, { takeover: true })
  assert.equal(decision.outcome, 'taken-over')
  assert.equal(lease(next).agent, 'second')
})

test('a claim on one folder says nothing about another', () => {
  const { decision, next } = decideLease(heldBy('first', 1), 'other-extension', 'second', NOW)
  assert.equal(decision.outcome, 'taken')
  assert.equal(lease(next).agent, 'first', 'the untouched folder keeps its holder')
})

test('the idle window is configurable so callers are not forced onto the default', () => {
  const held = heldBy('first', 5, 5)
  assert.equal(decideLease(held, 'some-extension', 'second', NOW, { idleMs: MINUTE }).decision.outcome, 'expired-taken')
})

test('the refusal message names the holder, the wait, and the way out', () => {
  const message = leaseRefusalMessage('some-extension', heldBy('first', 12, 3)['some-extension'], NOW, 'do the thing')
  assert.match(message, /first/)
  assert.match(message, /12 min/)
  assert.match(message, /3 min/)
  assert.match(message, /do the thing/)
  assert.match(message, /advisory/i)
})

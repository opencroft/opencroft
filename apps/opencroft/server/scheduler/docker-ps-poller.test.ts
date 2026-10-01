import assert from 'node:assert/strict'
import test from 'node:test'

import { backoffMs, dockerNodeIds, isDue, nextFailureState } from './docker-ps-poller'

// ── nextFailureState ────────────────────────────────────────────────────

test('a first failure produces a transition (worth logging) and a nonzero backoff', () => {
  const now = 1_000_000
  const { next, transitioned } = nextFailureState(undefined, 'error', now)
  assert.equal(transitioned, true)
  assert.equal(next?.consecutiveFailures, 1)
  assert.ok(next && next.nextAttemptAt > now, 'backoff must push the next attempt into the future')
})

test('a second consecutive failure is not a transition -- no repeat log', () => {
  const now = 1_000_000
  const after1 = nextFailureState(undefined, 'error', now).next
  const { next, transitioned } = nextFailureState(after1, 'error', now + 1)
  assert.equal(transitioned, false)
  assert.equal(next?.consecutiveFailures, 2)
})

test('backoff grows across consecutive failures and never exceeds the cap', () => {
  let current: ReturnType<typeof nextFailureState>['next']
  let now = 0
  const attempts: number[] = []
  for (let i = 0; i < 10; i++) {
    const result = nextFailureState(current, 'error', now)
    current = result.next
    assert.ok(current)
    attempts.push(backoffMs(current.consecutiveFailures))
    now = current.nextAttemptAt
  }
  for (let i = 1; i < attempts.length; i++) {
    assert.ok(attempts[i] >= attempts[i - 1], `attempt ${i} backoff (${attempts[i]}) must not shrink`)
  }
  assert.ok(attempts[attempts.length - 1] <= 10 * 60_000, 'backoff must be capped')
  // Confirms it actually reached the cap within 10 failures, not just "coincidentally under it".
  assert.equal(attempts[attempts.length - 1], 10 * 60_000)
})

test('success after failures clears the state and is a transition', () => {
  const failing = nextFailureState(undefined, 'error', 0).next
  const { next, transitioned } = nextFailureState(failing, 'ok', 1000)
  assert.equal(next, undefined)
  assert.equal(transitioned, true)
})

test('success while already healthy is not a transition', () => {
  const { next, transitioned } = nextFailureState(undefined, 'ok', 0)
  assert.equal(next, undefined)
  assert.equal(transitioned, false)
})

// ── isDue ────────────────────────────────────────────────────────────────

test('a host with no failure record is always due', () => {
  assert.equal(isDue(undefined, 0), true)
  assert.equal(isDue(undefined, 999_999_999), true)
})

test('a host inside its backoff window is not due', () => {
  const state = { consecutiveFailures: 1, nextAttemptAt: 1000 }
  assert.equal(isDue(state, 500), false)
})

test('a host is due exactly at its nextAttemptAt and after', () => {
  const state = { consecutiveFailures: 1, nextAttemptAt: 1000 }
  assert.equal(isDue(state, 1000), true)
  assert.equal(isDue(state, 1001), true)
})

// ── backoffMs ────────────────────────────────────────────────────────────

test('backoffMs doubles per consecutive failure starting from the base', () => {
  assert.equal(backoffMs(1), 30_000)
  assert.equal(backoffMs(2), 60_000)
  assert.equal(backoffMs(3), 120_000)
  assert.equal(backoffMs(4), 240_000)
})

test('backoffMs is capped at 10 minutes', () => {
  assert.equal(backoffMs(20), 10 * 60_000)
})

// ── dockerNodeIds ────────────────────────────────────────────────────────

test("the polled nodes are the docker extension's own docker nodes, under whatever owner it has", () => {
  const nodes = [
    { id: 'd-1', type: 'some-owner.containers.docker' },
    { id: 'd-2', type: 'acme.widgets.docker' },
    { id: 'a-1', type: 'some-owner.containers.application' },
    { id: 'd-3', type: 'docker' },
  ]
  assert.deepEqual(dockerNodeIds(nodes, 'some-owner.containers'), ['d-1'])
})

test('with no docker extension nothing is polled', () => {
  assert.deepEqual(dockerNodeIds([{ id: 'd-1', type: 'some-owner.containers.docker' }], null), [])
})

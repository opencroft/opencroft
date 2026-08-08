import assert from 'node:assert/strict'
import test from 'node:test'

import { deriveOpenSessionStatus, deriveSessionStatus } from './session-status'

const NONE = new Set<string>()
const KEY = new Set(['k'])

test('offline when the key is in none of the sets', () => {
  assert.equal(deriveSessionStatus('k', { pending: NONE, active: NONE, alive: NONE }), 'offline')
})

test('idle when alive but neither active nor pending', () => {
  assert.equal(deriveSessionStatus('k', { pending: NONE, active: NONE, alive: KEY }), 'idle')
})

test('working when active (and alive)', () => {
  assert.equal(deriveSessionStatus('k', { pending: NONE, active: KEY, alive: KEY }), 'working')
})

test('waiting when pending (and alive)', () => {
  assert.equal(deriveSessionStatus('k', { pending: KEY, active: NONE, alive: KEY }), 'waiting')
})

test('waiting takes priority over working when both are set', () => {
  assert.equal(deriveSessionStatus('k', { pending: KEY, active: KEY, alive: KEY }), 'waiting')
})

test('working takes priority over idle when both are set', () => {
  assert.equal(deriveSessionStatus('k', { pending: NONE, active: KEY, alive: KEY }), 'working')
})

test('a different key is unaffected by another key being pending/active/alive', () => {
  assert.equal(deriveSessionStatus('other', { pending: KEY, active: KEY, alive: KEY }), 'offline')
})

// ── deriveOpenSessionStatus ──────────────────────────────────────────────────
//
// The open-session form takes the two busy flags from the stream and liveness
// separately, because the stream cannot report liveness. The states and the
// ordering must stay identical to the polled form above — these assert that,
// not merely that each input maps somewhere.

const NOT_BUSY = { turnActive: false, permissionPending: false }

test('open: idle when a process is alive and neither flag is set', () => {
  assert.equal(deriveOpenSessionStatus(NOT_BUSY, true), 'idle')
})

test('open: working while a turn is in flight', () => {
  assert.equal(deriveOpenSessionStatus({ turnActive: true, permissionPending: false }, true), 'working')
})

test('open: waiting while a permission request is unresolved', () => {
  assert.equal(deriveOpenSessionStatus({ turnActive: false, permissionPending: true }, true), 'waiting')
})

test('open: waiting takes priority over working, matching the polled derivation', () => {
  assert.equal(deriveOpenSessionStatus({ turnActive: true, permissionPending: true }, true), 'waiting')
})

// The reason liveness is a separate input rather than assumed from "the screen
// is open": a session whose process was reaped for idleness must stop reading
// as idle, and no stream event announces that.
test('open: offline once the process is gone, even though the screen is still attached', () => {
  assert.equal(deriveOpenSessionStatus(NOT_BUSY, false), 'offline')
})

// A busy flag arriving from the stream is believed even if the polled liveness
// set has not caught up yet — the stream is the fresher of the two, and a turn
// cannot be running without a process behind it.
test('open: a turn reported by the stream outranks a stale not-yet-alive poll', () => {
  assert.equal(deriveOpenSessionStatus({ turnActive: true, permissionPending: false }, false), 'working')
})

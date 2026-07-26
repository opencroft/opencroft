import assert from 'node:assert/strict'
import test from 'node:test'

import { deriveSessionStatus } from './session-status'

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

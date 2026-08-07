import assert from 'node:assert/strict'
import test from 'node:test'

import { composeEnvelope, stampDeliveryTime } from './message-envelope'

const SYSTEM = { spaceName: 'Agents', spaceSlug: 'agents', selectedNodeId: 'script-node_1' }
const SESSION_INIT = { jobContext: 'Triage tracker notifications.', instructions: ['Reply in English.', 'Be terse.'] }

// ── Sender-contribution matrix ───────────────────────────────────────────
// Chat always contributes `system`; send-message never does. Both only
// contribute `sessionInit` (task + instructions) when the session was just
// created — never on a delivery into an existing session.

test('chat + new session: system and sessionInit both present', () => {
  const out = composeEnvelope('hello', { system: SYSTEM, sessionInit: SESSION_INIT, isNewSession: true })
  assert.match(out, /<opencroft-system>/)
  assert.match(out, /<opencroft-task>Triage tracker notifications\.<\/opencroft-task>/)
  assert.match(out, /<opencroft-instruction>Reply in English\.<\/opencroft-instruction>/)
  assert.match(out, /<opencroft-instruction>Be terse\.<\/opencroft-instruction>/)
  assert.match(out, /hello$/)
})

test('chat + existing session: system present, sessionInit withheld', () => {
  const out = composeEnvelope('hello', { system: SYSTEM, sessionInit: SESSION_INIT, isNewSession: false })
  assert.match(out, /<opencroft-system>/)
  assert.doesNotMatch(out, /<opencroft-task>/)
  assert.doesNotMatch(out, /<opencroft-instruction>/)
})

test('send-message + new session: sessionInit present, no system', () => {
  const out = composeEnvelope('hello', { sessionInit: SESSION_INIT, isNewSession: true })
  assert.doesNotMatch(out, /<opencroft-system>/)
  assert.match(out, /<opencroft-task>/)
  assert.match(out, /<opencroft-instruction>/)
})

// This is the restart-regression case: a send-message delivery into a session
// resumed via a cold-start `session/load` reports `created: false` (isNewSession
// false here) exactly like a normal cache-hit resume, so instructions must not
// be re-injected even though the graph still resolves non-empty ones.
test('send-message + existing session: neither system nor sessionInit, message untouched', () => {
  const out = composeEnvelope('hello', { sessionInit: SESSION_INIT, isNewSession: false })
  assert.equal(out, 'hello')
})

// ── Slash commands pass through unwrapped ────────────────────────────────

test('a leading-slash message is never wrapped, even for a new session', () => {
  const out = composeEnvelope('/reset', { system: SYSTEM, sessionInit: SESSION_INIT, isNewSession: true })
  assert.equal(out, '/reset')
})

// ── sessionInit content details ──────────────────────────────────────────

test('titleRequest is included only alongside sessionInit on a new session', () => {
  const out = composeEnvelope('hello', {
    sessionInit: { titleRequest: '<opencroft-title-request>title me</opencroft-title-request>' },
    isNewSession: true,
  })
  assert.match(out, /<opencroft-title-request>title me<\/opencroft-title-request>/)
})

test('blank/whitespace-only jobContext and instructions are omitted', () => {
  const out = composeEnvelope('hello', {
    sessionInit: { jobContext: '   ', instructions: ['', '   '] },
    isNewSession: true,
  })
  assert.equal(out, 'hello')
})

test('no options at all leaves the message untouched', () => {
  assert.equal(composeEnvelope('hello', { isNewSession: false }), 'hello')
  assert.equal(composeEnvelope('hello', { isNewSession: true }), 'hello')
})

// ── stampDeliveryTime ─────────────────────────────────────────────────────

test('stampDeliveryTime prefixes an opencroft-time tag in dd.mm.yyyy hh:mm:ss UTC', () => {
  const now = new Date(Date.UTC(2026, 0, 5, 3, 4, 5))
  const out = stampDeliveryTime('hello', now)
  assert.equal(out, '<opencroft-time>05.01.2026 03:04:05</opencroft-time>\nhello')
})

test('stampDeliveryTime zero-pads single-digit fields', () => {
  const now = new Date(Date.UTC(2026, 8, 7, 9, 2, 0))
  const out = stampDeliveryTime('hello', now)
  assert.match(out, /^<opencroft-time>07\.09\.2026 09:02:00<\/opencroft-time>\n/)
})

test('a leading-slash message is passed through unstamped', () => {
  const now = new Date(Date.UTC(2026, 0, 5, 3, 4, 5))
  assert.equal(stampDeliveryTime('/compact', now), '/compact')
  assert.equal(stampDeliveryTime('  /reset', now), '  /reset')
})

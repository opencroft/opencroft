import assert from 'node:assert/strict'
import test from 'node:test'

import { composeEnvelope, splitEnvelope, stripDeliveryStamp, wrapUserSelection } from './message-envelope'

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

// ── wrapUserSelection ─────────────────────────────────────────────────────

test('wrapUserSelection prefixes the selection tag ahead of the message', () => {
  const out = wrapUserSelection('what does this do?', 'const x = 1')
  assert.equal(out, '<opencroft-user-selection>const x = 1</opencroft-user-selection>\nwhat does this do?')
})

test('wrapUserSelection trims the content and wraps nothing when it is blank', () => {
  assert.equal(
    wrapUserSelection('hello', '  const x = 1  '),
    '<opencroft-user-selection>const x = 1</opencroft-user-selection>\nhello',
  )
  assert.equal(wrapUserSelection('hello', '   '), 'hello')
  assert.equal(wrapUserSelection('hello', ''), 'hello')
})

test('wrapUserSelection passes a leading-slash message through untouched', () => {
  assert.equal(wrapUserSelection('/compact', 'const x = 1'), '/compact')
  assert.equal(wrapUserSelection('  /reset', 'const x = 1'), '  /reset')
})

// ── the delivery stamp, which nothing writes any more ─────────────────────
//
// What the three removed tests protected: that a `dd.mm.yyyy hh:mm:ss` prefix
// was written at delivery, zero-padded, and skipped for a leading-slash
// command. Nothing produces one now -- every message carries `datetime` on its
// own tag instead, which is ISO 8601 with a zone rather than day-first without
// one -- so there is no producer left to protect.
//
// The stripper is a different matter and keeps its test below. Turns delivered
// before the removal still carry a stamp in the event log, so the strip is
// about historical data rather than about anything this code writes.

// -- splitting a delivered message back apart, for editing ------------------

test('splitEnvelope separates the context this app attached from the words', () => {
  const message = '<opencroft-user-selection>node: db-1</opencroft-user-selection>\nrestart it please'
  assert.deepEqual(splitEnvelope(message), {
    context: '<opencroft-user-selection>node: db-1</opencroft-user-selection>\n',
    words: 'restart it please',
  })
})

test('splitEnvelope takes every leading context block, not just the first', () => {
  const message =
    '<opencroft-system>space: Ops</opencroft-system>\n<opencroft-task>deploy</opencroft-task>\nwhat is left?'
  const { context, words } = splitEnvelope(message)
  assert.equal(words, 'what is left?')
  assert.equal(context + words, message, 'the two halves have to reassemble the message exactly')
})

test('a message with no context is all words', () => {
  assert.deepEqual(splitEnvelope('just a message'), { context: '', words: 'just a message' })
})

test('a tag quoted mid-sentence is a sentence, not context', () => {
  // Anchored matching. The reader was shown this text with nothing stripped out
  // of the middle, so there is nothing here to splice back either.
  const message = 'the format is <opencroft-task>like this</opencroft-task> apparently'
  assert.deepEqual(splitEnvelope(message), { context: '', words: message })
})

test('stripDeliveryStamp removes the delivery time, and only from the front', () => {
  // Written out rather than produced, because nothing produces one any more.
  // This is what a turn delivered before the stamp was removed still looks
  // like in the event log, and editing one re-delivers its text -- so without
  // the strip it would go back out carrying the moment it was FIRST received.
  const stamped = '<opencroft-time>07.09.2026 09:02:00</opencroft-time>\nhello'
  assert.equal(stripDeliveryStamp(stamped), 'hello')
  assert.equal(stripDeliveryStamp('hello'), 'hello', 'nothing to strip is not an error')
  const quoted = 'see <opencroft-time>01.01.2026 00:00:00</opencroft-time> in the log'
  assert.equal(stripDeliveryStamp(quoted), quoted, 'only a leading stamp is a stamp')
})

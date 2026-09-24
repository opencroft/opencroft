import assert from 'node:assert/strict'
import test from 'node:test'

import { tryParseJsonMessage } from './send-message-helpers'

test('tryParseJsonMessage requires a string message, and returns exactly message, queue and thread', () => {
  assert.equal(tryParseJsonMessage('not json'), null)
  assert.equal(tryParseJsonMessage('null'), null, 'JSON, but not an object')
  assert.equal(tryParseJsonMessage('{"agent":"alice"}'), null, 'no message field')
  assert.equal(tryParseJsonMessage('{"message":42,"queue":"wait"}'), null, 'a message that is not a string')
  assert.deepEqual(tryParseJsonMessage('{"message":"hi","queue":"push"}'), {
    message: 'hi',
    queue: 'push',
    thread: undefined,
  })
})

// What the removed `sender` field used to protect, and where that protection
// lives now. It was a caller-supplied author, coerced like any other optional
// field -- so the old tests pinned that it was trimmed and dropped when
// unusable, which is exactly the wrong guarantee: an author the caller may
// write is an author the caller may write wrongly. The parser no longer reads
// it at all, and who a message is from is established by the send path from
// what fed the run (see message-author). This pins the removal, so a future
// "harmless" re-add is a failing test rather than a silent hole.
test('a sender in the payload is ignored entirely — the wire cannot name an author', () => {
  const parsed = tryParseJsonMessage('{"message":"hi","queue":"wait","sender":"agent.alice"}')
  assert.ok(parsed)
  assert.ok(!('sender' in parsed), 'not parsed, not carried, not renamed')
  assert.deepEqual(Object.keys(parsed).sort(), ['message', 'queue', 'thread'])
})

// The whole-object comparisons pin the shape; this is what makes the thread
// field in it mean something: a value that is not a non-empty string is
// dropped, and one that survives arrives trimmed.
test('the thread reference is trimmed, and dropped when it is not a non-empty string', () => {
  assert.deepEqual(tryParseJsonMessage('{"message":"hi","queue":"wait","thread":" dev.alice.standup "}'), {
    message: 'hi',
    queue: 'wait',
    thread: 'dev.alice.standup',
  })

  for (const thread of ['"   "', '7', 'null', '""']) {
    assert.deepEqual(
      tryParseJsonMessage(`{"message":"hi","queue":"wait","thread":${thread}}`),
      { message: 'hi', queue: 'wait', thread: undefined },
      `expected thread ${thread} to be dropped`,
    )
  }
})

test('tryParseJsonMessage carries a thread reference through', () => {
  assert.deepEqual(tryParseJsonMessage('{"message":"hi","thread":"dev.alice.standup","queue":"wait"}'), {
    message: 'hi',
    queue: 'wait',
    thread: 'dev.alice.standup',
  })
})

// Refused, not defaulted — and thrown rather than returned as null, because a
// null here means "not a payload, treat the whole thing as message text", which
// would deliver the caller's JSON as the message instead of saying what is wrong.
test('tryParseJsonMessage refuses a payload that does not state queue', () => {
  for (const payload of ['{"message":"hi"}', '{"message":"hi","queue":"maybe"}', '{"message":"hi","queue":true}']) {
    assert.throws(
      () => tryParseJsonMessage(payload),
      (error: { message?: string }) => {
        assert.match(error.message ?? '', /"queue" is required and must be "wait" or "push"/)
        return true
      },
      `expected ${payload} to be refused`,
    )
  }
})

test('a payload still sending the retired force is pointed at its replacement', () => {
  assert.throws(
    () => tryParseJsonMessage('{"message":"hi","force":true}'),
    (error: { message?: string }) => {
      assert.match(error.message ?? '', /`force` has been replaced by `queue: "push"`/)
      return true
    },
  )
})

// These fields were once coerced like `thread` — trimmed, and dropped when
// blank. They addressed direct agent sessions, which no longer exist, so each
// is now refused by name whatever it holds: a blank value that used to vanish
// quietly is refused too, and a thread alongside does not rescue the payload.
test('each removed direct-session field is refused by name, even blank and even beside a thread', () => {
  for (const field of ['agent', 'job', 'key', 'session']) {
    for (const value of ['"alice"', '"   "']) {
      assert.throws(
        () => tryParseJsonMessage(`{"message":"hi","queue":"wait","thread":"dev.alice.standup","${field}":${value}}`),
        (error: { message?: string }) => {
          assert.match(error.message ?? '', new RegExp(`^send: "${field}" addressed a direct agent session`))
          return true
        },
        `expected ${field}: ${value} to be refused`,
      )
    }
  }

  assert.throws(
    () => tryParseJsonMessage('{"message":"hi","queue":"wait","agent":"alice","job":"task"}'),
    (error: { message?: string }) => {
      assert.match(error.message ?? '', /^send: "agent", "job" addressed a direct agent session/)
      return true
    },
  )
})

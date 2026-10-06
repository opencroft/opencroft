import assert from 'node:assert/strict'
import test from 'node:test'

import type { ChatEvent } from 'agent-client/types'

import {
  endOpenReply,
  INITIAL_STATE,
  type IndexState,
  indexEvents,
  type RecordedEvent,
  SEGMENT_CHARS,
  splitText,
} from './transcript-messages'

const AT = new Date('2026-01-01T00:00:00Z')
const at = (position: number, event: ChatEvent): RecordedEvent => ({ position, event, createdAt: AT })
const reply = (text: string): ChatEvent => ({ kind: 'agent_message', text })
const turnEnd: ChatEvent = { kind: 'turn_end', stopReason: 'end_turn' }
const row = (position: number, role: 'user' | 'agent', turn: number, text: string, segment = 0) => ({
  position,
  segment,
  role,
  turn,
  text,
  createdAt: AT,
})

test('a question is written as soon as it is recorded', () => {
  const step = indexEvents(INITIAL_STATE, [at(0, { kind: 'user', text: 'how do I deploy' })])
  assert.deepEqual(step.rows, [row(0, 'user', 0, 'how do I deploy')])
  assert.deepEqual(step.state, { resumeFrom: 1, turn: 0, open: null })
  assert.equal(step.persist, true)
})

test('a reply is held while it streams, and a batch of only its chunks writes nothing', () => {
  const step = indexEvents({ resumeFrom: 1, turn: 0, open: null }, [
    at(1, reply('Run the dep')),
    at(2, { kind: 'tool_call', toolCallId: 'call-1', title: 'Read file', status: 'pending' }),
    at(3, reply('loy script.')),
  ])
  assert.deepEqual(step.rows, [])
  assert.equal(step.persist, false)
  assert.deepEqual(step.state, {
    resumeFrom: 1,
    turn: 0,
    open: { position: 1, segment: 0, text: 'Run the deploy script.', createdAt: AT },
  })
})

test('a reply is written whole when its turn ends, tool calls and thoughts left out', () => {
  const step = indexEvents(INITIAL_STATE, [
    at(0, { kind: 'user', text: 'how do I deploy' }),
    at(1, reply('Run the ')),
    at(2, { kind: 'agent_thought', text: 'thinking about secrets' }),
    at(3, reply('deploy script.')),
    at(4, turnEnd),
  ])
  assert.deepEqual(step.rows, [row(0, 'user', 0, 'how do I deploy'), row(1, 'agent', 0, 'Run the deploy script.')])
  assert.deepEqual(step.state, { resumeFrom: 5, turn: 0, open: null })
})

test('an error ends a reply as a turn_end does', () => {
  const step = indexEvents({ resumeFrom: 1, turn: 0, open: null }, [
    at(1, reply('half an answer')),
    at(2, { kind: 'error', message: 'the agent stopped' }),
  ])
  assert.deepEqual(step.rows, [row(1, 'agent', 0, 'half an answer')])
  assert.equal(step.state.open, null)
})

test('a reply that never gets a turn_end or an error is ended by the next question', () => {
  const step = indexEvents({ resumeFrom: 1, turn: 0, open: null }, [
    at(1, reply('cut off mid')),
    at(2, { kind: 'user', text: 'are you there' }),
  ])
  assert.deepEqual(step.rows, [row(1, 'agent', 0, 'cut off mid'), row(2, 'user', 2, 'are you there')])
  assert.deepEqual(step.state, { resumeFrom: 3, turn: 2, open: null })
})

test('a turn_end with nothing open still moves the resume point past the turn', () => {
  const step = indexEvents({ resumeFrom: 3, turn: 0, open: null }, [at(7, turnEnd)])
  assert.deepEqual(step, { rows: [], state: { resumeFrom: 8, turn: 0, open: null }, persist: true })
})

test('text after a reply has ended starts a new message in the same turn', () => {
  const step = indexEvents({ resumeFrom: 1, turn: 0, open: null }, [
    at(1, reply('first')),
    at(2, turnEnd),
    at(3, reply('an afterthought')),
    at(4, turnEnd),
  ])
  assert.deepEqual(step.rows, [row(1, 'agent', 0, 'first'), row(3, 'agent', 0, 'an afterthought')])
})

test('reply text before any question opens a turn at its own first chunk', () => {
  const step = indexEvents(INITIAL_STATE, [at(7, reply('Hello, ')), at(8, reply('I am here.')), at(9, turnEnd)])
  assert.deepEqual(step.rows, [row(7, 'agent', 7, 'Hello, I am here.')])
  assert.equal(step.state.turn, 7)
})

test('a delivered question is indexed as the words its messages carry, without the tag lines', () => {
  const delivered = [
    'A note addressed to the agent.',
    '',
    '<agent-message author="alice" datetime="2026-01-01T10:00:00.000Z"/>',
    'first message',
    '<agent-message author="bob" datetime="2026-01-01T10:01:00.000Z"/>',
    'second message',
  ].join('\n')
  const step = indexEvents(INITIAL_STATE, [at(0, { kind: 'user', text: delivered })])
  assert.deepEqual(step.rows, [row(0, 'user', 0, 'first message\n\nsecond message')])
})

test('events before the resume point are already accounted for, and skipped', () => {
  // History recorded again below the resume point (an edit's fork, a replay).
  const step = indexEvents({ resumeFrom: 10, turn: 4, open: null }, [
    at(7, { kind: 'user', text: 'already indexed' }),
    at(8, reply('also already indexed')),
    at(9, turnEnd),
    at(10, { kind: 'user', text: 'new' }),
  ])
  assert.deepEqual(step.rows, [row(10, 'user', 10, 'new')])
})

test('the state passed in is not changed', () => {
  const before: IndexState = {
    resumeFrom: 1,
    turn: 0,
    open: { position: 1, segment: 0, text: 'so far', createdAt: AT },
  }
  const copy = structuredClone(before)
  indexEvents(before, [at(2, reply(' and more')), at(3, turnEnd)])
  assert.deepEqual(before, copy)
})

// ── Holding a long reply ──────────────────────────────────────────────────

test('held text past the segment size is written out at the next word break, and the reply goes on', () => {
  const open = { position: 1, segment: 0, text: 'x'.repeat(SEGMENT_CHARS - 2), createdAt: AT }
  const step = indexEvents({ resumeFrom: 1, turn: 0, open }, [
    at(5, reply('abc')),
    at(6, reply(' def')),
    at(7, reply(' ghi')),
  ])
  // The chunk starting with a space after a full segment is where it is cut:
  // the events before it are written, and the reply resumes from it.
  assert.deepEqual(step.rows, [row(1, 'agent', 0, `${'x'.repeat(SEGMENT_CHARS - 2)}abc`)])
  assert.deepEqual(step.state, {
    resumeFrom: 6,
    turn: 0,
    open: { position: 1, segment: 1, text: ' def ghi', createdAt: AT },
  })
  const ended = indexEvents(step.state, [at(8, turnEnd)])
  assert.deepEqual(ended.rows, [row(1, 'agent', 0, ' def ghi', 1)])
})

test('a reply streamed in small chunks never holds much more than twice the segment size', () => {
  let state: IndexState = { resumeFrom: 1, turn: 0, open: null }
  let written = ''
  let longestHeld = 0
  const words = Array.from({ length: 30_000 }, (_, i) => ` w${i}`)
  for (const [i, word] of words.entries()) {
    const step = indexEvents(state, [at(i + 1, reply(word))])
    written += step.rows.map((r) => r.text).join('')
    state = step.state
    longestHeld = Math.max(longestHeld, state.open?.text.length ?? 0)
  }
  written += indexEvents(state, [at(words.length + 1, turnEnd)])
    .rows.map((r) => r.text)
    .join('')
  assert.equal(written, words.join(''))
  assert.ok(longestHeld <= SEGMENT_CHARS + 10, `held ${longestHeld} characters`)
})

test('a reply in large chunks is written in full segments, not a full one and a sliver each time', () => {
  // Chunks cut anywhere in a word: the held text passes the segment size
  // mid-chunk and is written out at the next chunk that starts a word.
  const text = ` ${Array.from({ length: 40_000 }, (_, i) => `w${i.toString(36)}`).join(' ')}`
  let state: IndexState = { resumeFrom: 1, turn: 0, open: null }
  const lengths: number[] = []
  let position = 1
  for (let i = 0; i < text.length; i += 4000) {
    const batch: RecordedEvent[] = []
    for (let j = i; j < Math.min(text.length, i + 4000); j += 200) {
      batch.push(at(position++, reply(text.slice(j, j + 200))))
    }
    const step = indexEvents(state, batch)
    lengths.push(...step.rows.map((r) => r.text.length))
    state = step.state
  }
  lengths.push(...indexEvents(state, [at(position, turnEnd)]).rows.map((r) => r.text.length))
  assert.equal(
    lengths.reduce((sum, length) => sum + length, 0),
    text.length,
  )
  for (const length of lengths.slice(0, -1)) {
    assert.ok(length >= SEGMENT_CHARS && length <= 2 * SEGMENT_CHARS, `a segment of ${length} characters`)
  }
})

test('one chunk larger than a segment is written as several segments at once', () => {
  const text = Array.from({ length: 12_000 }, (_, i) => `word${i}`).join(' ')
  const step = indexEvents({ resumeFrom: 1, turn: 0, open: null }, [at(1, reply(text))])
  assert.ok(step.rows.length > 1, 'more than one segment')
  assert.deepEqual(
    step.rows.map((r) => r.segment),
    step.rows.map((_, index) => index),
  )
  assert.equal(step.rows.map((r) => r.text).join(''), text)
  assert.deepEqual(step.state.open, { position: 1, segment: step.rows.length, text: '', createdAt: AT })
  assert.equal(step.state.resumeFrom, 2)
})

test('a long question is split into segments at word breaks', () => {
  const words = Array.from({ length: 12_000 }, (_, i) => `word${i}`).join(' ')
  const { rows } = indexEvents(INITIAL_STATE, [at(0, { kind: 'user', text: words })])
  assert.ok(rows.length > 1)
  assert.equal(rows.map((r) => r.text).join(''), words)
  for (const r of rows.slice(1)) {
    assert.match(r.text, /^ word\d+/, 'each segment after the first starts at a word break')
  }
})

test('a text with no word break is cut at twice the segment size, keeping a surrogate pair together', () => {
  const text = `${'x'.repeat(2 * SEGMENT_CHARS - 1)}😀${'y'.repeat(5)}`
  assert.deepEqual(
    splitText(text).map((piece) => piece.length),
    [2 * SEGMENT_CHARS - 1, 7],
  )
  assert.equal(splitText(text)[1], `😀${'y'.repeat(5)}`)
})

// ── A reply whose writer is gone ──────────────────────────────────────────

test('ending an open reply writes what it holds and closes it', () => {
  const open = { position: 4, segment: 2, text: 'the rest', createdAt: AT }
  const step = endOpenReply({ resumeFrom: 9, turn: 3, open }, 12)
  assert.deepEqual(step.rows, [row(4, 'agent', 3, 'the rest', 2)])
  assert.deepEqual(step.state, { resumeFrom: 12, turn: 3, open: null })
})

test('ending when nothing is open changes nothing', () => {
  const state: IndexState = { resumeFrom: 9, turn: 3, open: null }
  assert.deepEqual(endOpenReply(state, 12), { rows: [], state, persist: false })
})

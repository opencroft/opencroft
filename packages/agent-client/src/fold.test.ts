import assert from 'node:assert/strict'
import test from 'node:test'

import { foldEvents } from './fold'
import type { ChatEvent } from './types'

// How streamed text becomes blocks. The harness's `messageId` is its own
// message boundary: two defined, different ids never share a block, and a
// chunk goes back to the block its id already has when only user bubbles came
// between. Absent ids fold by kind and position alone, which is every harness
// that stamps none.

const say = (text: string, messageId?: string): ChatEvent => ({
  kind: 'agent_message',
  text,
  ...(messageId ? { messageId } : {}),
})
const think = (text: string, messageId?: string): ChatEvent => ({
  kind: 'agent_thought',
  text,
  ...(messageId ? { messageId } : {}),
})
const user = (text: string): ChatEvent => ({ kind: 'user', text })
const turnEnd: ChatEvent = { kind: 'turn_end', stopReason: 'end_turn' }

function shape(events: ChatEvent[]): string[] {
  return foldEvents(events).map((message) =>
    message.kind === 'assistant' || message.kind === 'thought' || message.kind === 'user'
      ? `${message.kind}:${message.text}`
      : message.kind,
  )
}

test('consecutive chunks with no ids join one block, as they always did', () => {
  assert.deepEqual(shape([say('Hel'), say('lo'), think('hm'), think('m')]), ['assistant:Hello', 'thought:hmm'])
})

test('consecutive chunks with the same id join one block', () => {
  assert.deepEqual(shape([say('Hel', 'm1'), say('lo', 'm1')]), ['assistant:Hello'])
})

test('consecutive chunks with different ids are different blocks', () => {
  assert.deepEqual(shape([say('First.', 'm1'), say('Second.', 'm2')]), ['assistant:First.', 'assistant:Second.'])
  assert.deepEqual(shape([think('a', 't1'), think('b', 't2')]), ['thought:a', 'thought:b'])
})

test('an id on one side only does not split: a harness that stamps some chunks folds as before', () => {
  assert.deepEqual(shape([say('Hel'), say('lo', 'm1')]), ['assistant:Hello'])
  assert.deepEqual(shape([say('Hel', 'm1'), say('lo')]), ['assistant:Hello'])
})

test('the tail of a reply streamed after a steered message finishes that reply, not the next one', () => {
  // The steered message is shown the moment it is injected, while the reply
  // it interrupted is still streaming; the model's answer to it comes next.
  assert.deepEqual(
    shape([say('Working on ', 'm1'), user('stop and summarise'), say('it.', 'm1'), say('Summary.', 'm2')]),
    ['assistant:Working on it.', 'user:stop and summarise', 'assistant:Summary.'],
  )
})

test('a thought and a message under the same id stay apart, and in order', () => {
  assert.deepEqual(shape([think('plan', 'x'), say('answer', 'x'), think('more', 'x')]), [
    'thought:plan',
    'assistant:answer',
    'thought:more',
  ])
})

test('a turn boundary closes every block: an id seen again next turn opens a new one', () => {
  assert.deepEqual(shape([say('One.', 'm1'), turnEnd, user('again'), say('Two.', 'm1')]), [
    'assistant:One.',
    'user:again',
    'assistant:Two.',
  ])
})

test('one Claude API message streaming text, a tool call, then text keeps that order', () => {
  // claude-agent-acp stamps the API message id on every chunk of it, tool use
  // included in between: the second text is after the tool call, not part of
  // the first.
  const events: ChatEvent[] = [
    say('Let me look.', 'msg_1'),
    { kind: 'tool_call', toolCallId: 'toolu_1', title: 'Read', status: 'pending' },
    say('Found it.', 'msg_1'),
  ]
  assert.deepEqual(shape(events), ['assistant:Let me look.', 'tool', 'assistant:Found it.'])
})

test('after a tool call, the same id continues the NEW block, not the one above the call', () => {
  const events: ChatEvent[] = [
    say('Before.', 'msg_1'),
    { kind: 'tool_call', toolCallId: 'toolu_1', title: 'Read', status: 'pending' },
    say('After ', 'msg_1'),
    user('a steer'),
    say('the steer.', 'msg_1'),
  ]
  assert.deepEqual(shape(events), ['assistant:Before.', 'tool', 'assistant:After the steer.', 'user:a steer'])
})

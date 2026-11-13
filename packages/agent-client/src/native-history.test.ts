import assert from 'node:assert/strict'
import test from 'node:test'

import { summaryMessages } from './native-compaction'
import { conversationFromLog } from './native-history'
import type { ChatEvent } from './types'

const user = (text: string): ChatEvent => ({ kind: 'user', text })
const said = (text: string): ChatEvent => ({ kind: 'agent_message', text })
const end: ChatEvent = { kind: 'turn_end', stopReason: 'end_turn' }
const compaction = (status: string, summary?: string): ChatEvent => ({
  kind: 'compaction',
  compaction: { compactionId: 'compaction-1', status, ...(summary ? { summary } : {}) },
})

test('text turns become user and assistant messages, chunks of one reply joined', () => {
  assert.deepEqual(conversationFromLog([user('Hi'), said('Hel'), said('lo.'), end, user('Bye'), said('See you.'), end]), [
    { role: 'user', content: 'Hi' },
    { role: 'assistant', content: [{ type: 'text', text: 'Hello.' }] },
    { role: 'user', content: 'Bye' },
    { role: 'assistant', content: [{ type: 'text', text: 'See you.' }] },
  ])
})

test('a step with tool calls is an assistant message with the calls and a tool message with their results', () => {
  const events: ChatEvent[] = [
    user('Look it up'),
    said('Checking.'),
    { kind: 'tool_call', toolCallId: 'c1', title: 'search', status: 'in_progress', input: { q: 'heron' } },
    { kind: 'tool_update', toolCallId: 'c1', status: 'completed', output: 'found it' },
    { kind: 'tool_call', toolCallId: 'c2', title: 'fetch', status: 'in_progress', input: {} },
    { kind: 'tool_update', toolCallId: 'c2', status: 'failed', output: 'Command exited with code 3' },
    said('Done.'),
    end,
  ]
  assert.deepEqual(conversationFromLog(events), [
    { role: 'user', content: 'Look it up' },
    {
      role: 'assistant',
      content: [
        { type: 'text', text: 'Checking.' },
        { type: 'tool-call', toolCallId: 'c1', toolName: 'search', input: { q: 'heron' } },
        { type: 'tool-call', toolCallId: 'c2', toolName: 'fetch', input: {} },
      ],
    },
    {
      role: 'tool',
      content: [
        { type: 'tool-result', toolCallId: 'c1', toolName: 'search', output: { type: 'text', value: 'found it' } },
        {
          type: 'tool-result',
          toolCallId: 'c2',
          toolName: 'fetch',
          output: { type: 'error-text', value: 'Command exited with code 3' },
        },
      ],
    },
    { role: 'assistant', content: [{ type: 'text', text: 'Done.' }] },
  ])
})

test('a call that never settled is answered as stopped, and structured output stays JSON', () => {
  const events: ChatEvent[] = [
    user('Go'),
    { kind: 'tool_call', toolCallId: 'c1', title: 'probe', status: 'in_progress', input: {} },
    { kind: 'tool_update', toolCallId: 'c1', status: 'completed', output: { content: [{ type: 'text', text: 'ok' }] } },
    { kind: 'tool_call', toolCallId: 'c2', title: 'sleep', status: 'in_progress', input: {} },
  ]
  const tool = conversationFromLog(events).find((message) => message.role === 'tool')
  assert.ok(tool && Array.isArray(tool.content))
  assert.deepEqual(
    tool.content.map((part) => (part.type === 'tool-result' ? part.output : null)),
    [
      { type: 'json', value: { content: [{ type: 'text', text: 'ok' }] } },
      { type: 'error-text', value: 'The call was stopped before it finished.' },
    ],
  )
})

test('what the model never saw is left out: reasoning, cards, notices', () => {
  const events: ChatEvent[] = [
    user('Hi'),
    { kind: 'agent_thought', text: 'thinking' },
    { kind: 'permission_request', requestId: 'r1', title: 'run', options: [] },
    { kind: 'permission_resolved', requestId: 'r1', optionId: 'allow' },
    { kind: 'notice', notice: { severity: 'info', title: 'fallback' } },
    said('Hello.'),
    end,
  ]
  assert.deepEqual(conversationFromLog(events), [
    { role: 'user', content: 'Hi' },
    { role: 'assistant', content: [{ type: 'text', text: 'Hello.' }] },
  ])
})

test('the context begins with the summary of the newest completed compaction', () => {
  const events: ChatEvent[] = [
    user('Old question'),
    said('Old answer.'),
    end,
    user('Work on it'),
    said('Step one.'),
    compaction('completed', 'Everything so far.'),
    said('Step two.'),
    end,
  ]
  assert.deepEqual(conversationFromLog(events), [
    ...summaryMessages('Everything so far.'),
    { role: 'assistant', content: [{ type: 'text', text: 'Step two.' }] },
  ])
})

test("a compaction before a turn's first call keeps the turn's prompt after the summary", () => {
  const events: ChatEvent[] = [
    user('Old question'),
    said('Old answer.'),
    end,
    user('New question'),
    compaction('completed', 'The old exchange.'),
    said('New answer.'),
    end,
  ]
  assert.deepEqual(conversationFromLog(events), [
    ...summaryMessages('The old exchange.'),
    { role: 'user', content: 'New question' },
    { role: 'assistant', content: [{ type: 'text', text: 'New answer.' }] },
  ])
})

test('a /compact command is not kept after its summary, and a failed compaction cuts nothing', () => {
  const compacted: ChatEvent[] = [user('Question'), said('Answer.'), end, user('/compact'), compaction('completed', 'S.'), end]
  assert.deepEqual(conversationFromLog(compacted), summaryMessages('S.'))
  const failed: ChatEvent[] = [user('Question'), said('Answer.'), end, user('/compact'), compaction('failed'), end]
  assert.deepEqual(conversationFromLog(failed), [
    { role: 'user', content: 'Question' },
    { role: 'assistant', content: [{ type: 'text', text: 'Answer.' }] },
    { role: 'user', content: '/compact' },
  ])
})

test("a session_start mark begins the context: the earlier session's history was never this model's", () => {
  const events: ChatEvent[] = [user('Before'), said('Earlier.'), end, { kind: 'session_start', sessionId: 's2' }, user('After')]
  assert.deepEqual(conversationFromLog(events), [{ role: 'user', content: 'After' }])
})

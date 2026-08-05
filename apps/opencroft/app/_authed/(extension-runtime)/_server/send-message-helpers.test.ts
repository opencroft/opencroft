import assert from 'node:assert/strict'
import test from 'node:test'

import { buildSessionKey, parseSessionKey, resolveSessionOnGraph, tryParseJsonMessage } from './send-message-helpers'

test('buildSessionKey slugifies and omits the discriminator when absent', () => {
  assert.equal(buildSessionKey('Alice', 'Task'), 'agent:alice:task')
  assert.equal(buildSessionKey('Alice', 'Task', 'my key'), 'agent:alice:task:my-key')
})

test('parseSessionKey accepts and ignores an optional third segment', () => {
  assert.deepEqual(parseSessionKey('agent:alice:task'), { agentSlug: 'alice', jobSlug: 'task' })
  assert.deepEqual(parseSessionKey('agent:alice:task:my-key'), { agentSlug: 'alice', jobSlug: 'task' })
  assert.equal(parseSessionKey('not-a-session-key'), null)
})

test('tryParseJsonMessage requires a string message and coerces the rest', () => {
  assert.equal(tryParseJsonMessage('not json'), null)
  assert.equal(tryParseJsonMessage('{"agent":"alice"}'), null, 'no message field')
  assert.deepEqual(tryParseJsonMessage('{"message":"hi","force":true}'), {
    message: 'hi',
    agent: undefined,
    job: undefined,
    key: undefined,
    title: undefined,
    session: undefined,
    force: true,
  })
})

const graph = () => ({
  nodes: [
    { id: 'a1', type: 'agent', data: { name: 'Alice' } },
    { id: 'j1', type: 'agent-job', data: { name: 'Task', context: 'do the thing' } },
    { id: 'j2', type: 'agent-job', data: { name: 'Other job' } },
    { id: 'i1', type: 'agent-instruction', data: { instruction: 'Be terse.' } },
    { id: 'not-agent', type: 'send-message', data: { name: 'Alice' } },
  ],
  edges: [{ source: 'i1', target: 'a1', targetHandle: 'instructions-in' }],
})

test('resolveSessionOnGraph resolves agent + job by slug and collects wired instructions', () => {
  const { nodes, edges } = graph()
  const ctx = resolveSessionOnGraph('agent:alice:task', nodes, edges)
  assert.ok(ctx)
  assert.equal(ctx?.agentName, 'Alice')
  assert.equal(ctx?.agentNodeId, 'a1')
  assert.equal(ctx?.jobName, 'Task')
  assert.equal(ctx?.jobNodeId, 'j1')
  assert.equal(ctx?.jobContext, 'do the thing')
  assert.deepEqual(ctx?.instructions, ['Be terse.'])
})

test('resolveSessionOnGraph does not match a same-named node of the wrong type', () => {
  const { nodes, edges } = graph()
  // A send-message node also named "Alice" must not resolve as the agent.
  const ctx = resolveSessionOnGraph('agent:alice:other-job', nodes, edges)
  assert.equal(ctx?.jobName, 'Other job')
  assert.equal(ctx?.agentNodeId, 'a1', 'still the real agent node, not the send-message node sharing its name')
})

test('resolveSessionOnGraph returns null for an unresolvable agent or job slug', () => {
  const { nodes, edges } = graph()
  assert.equal(resolveSessionOnGraph('agent:nobody:task', nodes, edges), null)
  assert.equal(resolveSessionOnGraph('agent:alice:nojob', nodes, edges), null)
  assert.equal(resolveSessionOnGraph('not-a-session-key', nodes, edges), null)
})

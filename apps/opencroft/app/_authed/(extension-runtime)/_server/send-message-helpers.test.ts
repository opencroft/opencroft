import assert from 'node:assert/strict'
import test from 'node:test'

import {
  buildSessionKey,
  isAgentNodeReachable,
  parseSessionKey,
  reachableAgentJobs,
  reachablePairKey,
  reachablePairs,
  resolveSessionOnGraph,
  tryParseJsonMessage,
} from './send-message-helpers'

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
    thread: undefined,
  })
})

test('tryParseJsonMessage coerces a thread reference the same way as the other optional fields', () => {
  assert.deepEqual(tryParseJsonMessage('{"message":"hi","thread":"dev:alice:standup"}'), {
    message: 'hi',
    agent: undefined,
    job: undefined,
    key: undefined,
    title: undefined,
    session: undefined,
    force: false,
    thread: 'dev:alice:standup',
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

// A send-message node's reachability graph: the job -> agent edge that
// listAgents/listSessions/reachablePairs actually key on, which the
// resolveSessionOnGraph fixture above deliberately has none of (routing a
// session never required one). 'Idle Agent' is present in the space but wired
// to no job at all — an agent that exists without being a send target.
const reachabilityGraph = () => ({
  nodes: [
    { id: 'a1', type: 'agent', data: { name: 'Alice' } },
    { id: 'a2', type: 'agent', data: { name: 'Idle Agent' } },
    { id: 'j1', type: 'agent-job', data: { name: 'Task' } },
    { id: 'j2', type: 'agent-job', data: { name: 'Review' } },
  ],
  edges: [
    { source: 'j1', target: 'a1' },
    { source: 'j2', target: 'a1' },
  ],
})

test('reachableAgentJobs lists every agent in the space, with the jobs wired to it', () => {
  const { nodes, edges } = reachabilityGraph()
  const result = reachableAgentJobs(nodes, edges)
  assert.deepEqual(result.find((a) => a.agent === 'alice')?.jobs.sort(), ['review', 'task'])
  assert.deepEqual(result.find((a) => a.agent === 'idle-agent')?.jobs, [], 'present in the space, wired to nothing')
})

test('reachablePairs is exactly the flattened agent::job set', () => {
  const { nodes, edges } = reachabilityGraph()
  const pairs = reachablePairs(nodes, edges)
  assert.ok(pairs.has(reachablePairKey('alice', 'task')))
  assert.ok(pairs.has(reachablePairKey('alice', 'review')))
  assert.equal(pairs.size, 2, 'an agent with no job edge contributes no pairs')
})

test('isAgentNodeReachable is true only for an agent with at least one job wired to it, checked by id', () => {
  const { nodes, edges } = reachabilityGraph()
  assert.equal(isAgentNodeReachable(nodes, edges, 'a1'), true)
  assert.equal(isAgentNodeReachable(nodes, edges, 'a2'), false, 'present in the space but no job routes to it')
  assert.equal(isAgentNodeReachable(nodes, edges, 'not-a-node-id'), false)
})

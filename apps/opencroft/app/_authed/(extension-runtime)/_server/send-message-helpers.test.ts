import assert from 'node:assert/strict'
import test from 'node:test'

import {
  buildSessionKey,
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
  assert.deepEqual(tryParseJsonMessage('{"message":"hi","queue":"push"}'), {
    message: 'hi',
    agent: undefined,
    job: undefined,
    key: undefined,
    title: undefined,
    session: undefined,
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
  assert.deepEqual(Object.keys(parsed).sort(), [
    'agent',
    'job',
    'key',
    'message',
    'queue',
    'session',
    'thread',
    'title',
  ])
})

// The whole-object comparisons above pin the shape; this is what makes the
// shape mean something. Every optional field goes through one coercion, so
// they are exercised together rather than a test per field: a value that is
// not a non-empty string is dropped, and one that survives arrives trimmed.
test('every optional field is trimmed, and dropped when it is not a non-empty string', () => {
  assert.deepEqual(
    tryParseJsonMessage(
      '{"message":"hi","queue":"wait","agent":" alice ","job":" task ","key":" k ","title":" t ","session":" agent:alice:task "}',
    ),
    {
      message: 'hi',
      agent: 'alice',
      job: 'task',
      key: 'k',
      title: 't',
      session: 'agent:alice:task',
      queue: 'wait',
      thread: undefined,
    },
  )

  assert.deepEqual(
    tryParseJsonMessage('{"message":"hi","queue":"wait","agent":"   ","job":7,"key":null,"thread":""}'),
    {
      message: 'hi',
      agent: undefined,
      job: undefined,
      key: undefined,
      title: undefined,
      session: undefined,
      queue: 'wait',
      thread: undefined,
    },
  )
})

test('tryParseJsonMessage coerces a thread reference the same way as the other optional fields', () => {
  assert.deepEqual(tryParseJsonMessage('{"message":"hi","thread":"dev:alice:standup","queue":"wait"}'), {
    message: 'hi',
    agent: undefined,
    job: undefined,
    key: undefined,
    title: undefined,
    session: undefined,
    queue: 'wait',
    thread: 'dev:alice:standup',
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

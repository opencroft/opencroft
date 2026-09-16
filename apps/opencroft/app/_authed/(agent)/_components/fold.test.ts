import assert from 'node:assert/strict'
import test from 'node:test'

import { DEFAULT_PRESENCE } from 'agent-client/presence'
import type { ChatEvent } from 'agent-client/types'

import { fold } from './use-acp-session'

function turn(userText: string, replyText: string): ChatEvent[] {
  return [
    { kind: 'user', text: userText },
    { kind: 'agent_message', text: replyText },
  ]
}

test('message ids are baseIndex + event position', () => {
  const events = [...turn('q0', 'a0'), ...turn('q1', 'a1')]
  const { messages } = fold(events, 100)
  assert.deepEqual(
    messages.map((m) => m.id),
    [100, 101, 102, 103],
  )
})

test('a message keeps the same id when the same events are re-folded with a lower baseIndex after a prepend', () => {
  // Simulates loadMoreHistory: the tail arrives first (baseIndex 10, say),
  // then an older page of 2 raw events gets prepended and baseIndex drops by
  // 2 — every event already in the tail must keep its original id.
  const tailEvents = turn('q1', 'a1')
  const tailFold = fold(tailEvents, 10)
  const tailIds = tailFold.messages.map((m) => m.id)

  const olderEvents = turn('q0', 'a0')
  const combined = [...olderEvents, ...tailEvents]
  const combinedFold = fold(combined, 10 - olderEvents.length)

  // The two messages that were already visible (q1/a1) must have identical
  // ids before and after the prepend — this is what a stable React key
  // depends on; if it changed, React would treat them as new nodes and
  // rewrite/reuse DOM across the whole visible range instead of just
  // inserting the new older content above.
  const combinedTailIds = combinedFold.messages.slice(-tailIds.length).map((m) => m.id)
  assert.deepEqual(combinedTailIds, tailIds)
})

test('a multi-chunk assistant reply keeps the id of its FIRST chunk, not its last', () => {
  const events: ChatEvent[] = [
    { kind: 'user', text: 'q' },
    { kind: 'agent_message', text: 'chunk one ' },
    { kind: 'agent_message', text: 'chunk two ' },
    { kind: 'agent_message', text: 'chunk three' },
  ]
  const { messages } = fold(events, 0)
  assert.equal(messages.length, 2)
  assert.equal(messages[1].id, 1) // the first agent_message chunk's position
  assert.equal(messages[1].role, 'assistant')
  const [part] = messages[1].parts
  assert.equal(part.type, 'text')
  assert.equal(part.type === 'text' ? part.text : '', 'chunk one chunk two chunk three')
})

test('a tool_call keeps the id of the raw event that opened it, unaffected by later tool_update chunks', () => {
  const events: ChatEvent[] = [
    { kind: 'user', text: 'q' },
    { kind: 'tool_call', toolCallId: 't1', title: 'Read', status: 'pending', input: {} },
    { kind: 'tool_update', toolCallId: 't1', status: 'completed', output: 'done' },
  ]
  const { messages } = fold(events, 50)
  assert.equal(messages[1].id, 51)
})

test('a session nobody has set a cadence for reads in realtime', () => {
  // What every session did before a reading cadence existed. A new setting
  // must not change the behaviour of one that has not asked for it, and the
  // control has to show the same answer the engine is acting on.
  assert.deepEqual(fold(turn('q', 'a'), 0).presence, DEFAULT_PRESENCE)
})

test('the last presence snapshot wins, like the queue', () => {
  // Snapshots rather than deltas, so a client that reconnects mid-stream folds
  // the last one it sees and knows what it is looking at without asking.
  const events: ChatEvent[] = [
    { kind: 'presence', presence: { kind: 'hourly' } },
    { kind: 'user', text: 'q' },
    { kind: 'presence', presence: { kind: 'custom', intervalMs: 15 * 60_000 } },
  ]
  assert.deepEqual(fold(events, 0).presence, { kind: 'custom', intervalMs: 15 * 60_000 })
})

const PLAN_EVENTS: ChatEvent[] = [
  { kind: 'plan', entries: [{ content: 'read the code', status: 'in_progress', priority: 'high' }] },
  { kind: 'agent_message', text: 'starting' },
  {
    kind: 'plan',
    entries: [
      { content: 'read the code', status: 'completed', priority: 'high' },
      { content: 'fix the fold', status: 'in_progress', priority: 'high' },
    ],
  },
]

test('plan updates fold to one plan part, patched in place at its first event', () => {
  // Every plan event carries the FULL entry list, so one event per update must
  // not stack one checklist per update — the later event patches the part the
  // first anchored, and the checklist stays in the transcript where it began.
  const { messages } = fold(PLAN_EVENTS, 0)
  const plans = messages.flatMap((m) => m.parts.filter((p) => p.type === 'plan'))
  assert.equal(plans.length, 1)
  assert.deepEqual(
    plans.map((p) => (p.type === 'plan' ? p.entries : null)),
    [
      [
        { content: 'read the code', status: 'completed', priority: 'high' },
        { content: 'fix the fold', status: 'in_progress', priority: 'high' },
      ],
    ],
  )
  // The part carries the anchor event's absolute index, so React keeps the
  // checklist node while later events patch it.
  const owner = messages.find((m) => m.parts.some((p) => p.type === 'plan'))
  assert.ok(owner)
  assert.equal(owner.parts.find((p) => p.type === 'plan')?.id, 0)
})

test('an empty plan clears the part, and the next plan anchors fresh', () => {
  const cleared: ChatEvent[] = [...PLAN_EVENTS, { kind: 'plan', entries: [] }]
  assert.equal(fold(cleared, 0).messages.flatMap((m) => m.parts.filter((p) => p.type === 'plan')).length, 0)
  const reanchored: ChatEvent[] = [
    ...cleared,
    { kind: 'plan', entries: [{ content: 'fresh plan', status: 'in_progress', priority: 'high' }] },
  ]
  const plans = fold(reanchored, 0).messages.flatMap((m) => m.parts.filter((p) => p.type === 'plan'))
  assert.equal(plans.length, 1)
  assert.deepEqual(plans[0].type === 'plan' ? plans[0].entries : null, [
    { content: 'fresh plan', status: 'in_progress', priority: 'high' },
  ])
})

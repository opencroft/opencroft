// A chat whose subagents keep logs of their own: the session's history holds
// one header per subagent, the section's steps come from its own log once it
// is asked for, and every block is named by its position in the log rather
// than by how many events the client happens to hold.
import assert from 'node:assert/strict'
import test from 'node:test'

import { TranscriptLog } from 'agent-client/transcript-log'
import type { ChatEvent } from 'agent-client/types'

import { fold, foldSectionSteps } from '@/app/_authed/(agent)/_components/use-acp-session'
import {
  type SubagentSection,
  withSections,
  withStep,
  withWindow,
} from '@/app/_authed/(agent)/_components/use-subagent-sections'
import type { AuthoredChatEvent } from '@/app/_authed/(agent)/_lib/acp-stream'
import type { ChatPart } from '@/app/_authed/(agent)/_lib/messages'
import { subagentStepOf, withEntry } from '@/app/_authed/(agent)/_lib/subagent-frames'

const header = (state?: string, steps = 3): ChatEvent => ({
  kind: 'subagent',
  subagent: { subagentSessionId: 'child-1', name: 'Investigator', task: 'dig', steps, ...(state ? { state } : {}) },
})
const message = (text: string): ChatEvent => ({ kind: 'agent_message', text })
const at = (logIndex: number, event: ChatEvent): AuthoredChatEvent => ({ ...event, logIndex })

const ASKED: SubagentSection = { entries: new Map(), startIndex: null, hasMore: false, loading: true }

test('a message is named by the log position of the event that starts it, whatever the client holds', () => {
  // A merged entry and the chunks that grew it after the window name one
  // position; an id counted from the array would drift by one per chunk.
  const events = [
    at(40, { kind: 'user', text: 'go' }),
    at(41, message('Hel')),
    at(41, message('lo')),
    at(42, { kind: 'turn_end', stopReason: 'end_turn' }),
    at(43, { kind: 'user', text: 'again' }),
  ]
  const { messages } = fold(events)
  assert.deepEqual(
    messages.map((m) => [m.role, m.id]),
    [
      ['user', 40],
      ['assistant', 41],
      ['user', 43],
    ],
  )
  assert.deepEqual(messages[1]?.parts, [{ type: 'text', text: 'Hello' }])
})

test("a subagent's header carries its step count onto the part, with no steps of its own", () => {
  const { messages } = fold([at(0, { kind: 'user', text: 'go' }), at(1, header())])
  const part = messages[1]?.parts[0]
  assert.equal(part?.type, 'subagent')
  assert.equal(part?.type === 'subagent' ? part.steps : null, 3)
  assert.deepEqual(part?.type === 'subagent' ? part.parts : null, [])
})

test('a step frame is told apart from history, and the entry it names replaces what it carried', () => {
  const frame: ChatEvent = { kind: 'subagent_event', subagentSessionId: 'child-1', event: message('lo'), position: 2 }
  assert.deepEqual(subagentStepOf(frame), { subagentSessionId: 'child-1', position: 2, event: message('lo') })
  // A step stored inline in the session's own log carries no position and stays history.
  assert.equal(subagentStepOf({ kind: 'subagent_event', subagentSessionId: 'child-1', event: message('x') }), null)
  // Nested: the innermost subagent's log.
  const nested: ChatEvent = {
    kind: 'subagent_event',
    subagentSessionId: 'child-1',
    event: { kind: 'subagent_event', subagentSessionId: 'grandchild', event: message('deep'), position: 0 },
  }
  assert.equal(subagentStepOf(nested)?.subagentSessionId, 'grandchild')
  assert.deepEqual(subagentStepOf(withEntry(nested, message('deeper')))?.event, message('deeper'))
})

test('a frame that arrived while the window was being fetched is kept over the window', () => {
  const during = withStep(ASKED, { subagentSessionId: 'child-1', position: 1, event: message('Hello there') })
  const loaded = withWindow(during, { startIndex: 0, hasMore: true, events: [message('first'), message('Hello')] })
  assert.deepEqual(loaded.entries.get(1), message('Hello there'))
  assert.deepEqual(loaded.entries.get(0), message('first'))
  assert.equal(loaded.startIndex, 0)
  assert.equal(loaded.loading, false)
  // An older page extends the window upwards.
  const older = withWindow({ ...loaded, startIndex: 5 }, { startIndex: 3, hasMore: false, events: [] })
  assert.equal(older.startIndex, 3)
  assert.equal(older.hasMore, false)
})

function subagentOf(parts: ChatPart[] | undefined): Extract<ChatPart, { type: 'subagent' }> {
  const part = parts?.[0]
  assert.equal(part?.type, 'subagent')
  return part as Extract<ChatPart, { type: 'subagent' }>
}

test('a section draws nothing until it is loaded, then its own steps, and offers older ones while there are any', () => {
  const { messages } = fold([at(0, { kind: 'user', text: 'go' }), at(1, header())])
  const asked: string[] = []
  const actions = {
    expand: (id: string) => asked.push(`expand:${id}`),
    loadOlder: (id: string) => asked.push(`older:${id}`),
  }

  const collapsed = subagentOf(withSections(messages, new Map(), actions, foldSectionSteps)[1]?.parts)
  assert.deepEqual(collapsed.parts, [])
  assert.equal(collapsed.onLoadOlder, undefined)
  collapsed.onExpand?.()
  assert.deepEqual(asked, ['expand:child-1'])

  const loading = subagentOf(withSections(messages, new Map([['child-1', ASKED]]), actions, foldSectionSteps)[1]?.parts)
  assert.equal(loading.loading, true)

  const loaded = withWindow(ASKED, {
    startIndex: 4,
    hasMore: true,
    events: [message('found it'), { kind: 'tool_call', toolCallId: 't1', title: 'ls', status: 'pending' }],
  })
  const shown = subagentOf(withSections(messages, new Map([['child-1', loaded]]), actions, foldSectionSteps)[1]?.parts)
  assert.deepEqual(
    shown.parts.map((part) => part.type),
    ['text', 'tool-call'],
  )
  shown.onLoadOlder?.()
  assert.deepEqual(asked, ['expand:child-1', 'older:child-1'])
})

test("a subagent whose steps are stored inline in the session's own log keeps them, and loads nothing", () => {
  const { messages } = fold([
    at(0, { kind: 'user', text: 'go' }),
    at(1, { kind: 'subagent', subagent: { subagentSessionId: 'inline', name: 'Inline', task: 't' } }),
    at(2, { kind: 'subagent_event', subagentSessionId: 'inline', event: message('inline step') }),
  ])
  const actions = { expand: () => assert.fail('nothing to load'), loadOlder: () => assert.fail('nothing to load') }
  const part = subagentOf(withSections(messages, new Map(), actions, foldSectionSteps)[1]?.parts)
  assert.equal(part.steps, undefined)
  assert.equal(part.onExpand, undefined)
  assert.deepEqual(part.parts, [{ type: 'text', text: 'inline step' }])
})

test('an ended subagent closes the calls it left open, as a turn end does', () => {
  const steps: ChatEvent[] = [{ kind: 'tool_call', toolCallId: 't1', title: 'ls', status: 'in_progress' }]
  const running = foldSectionSteps(steps, false)[0]
  const ended = foldSectionSteps(steps, true)[0]
  assert.equal(running?.type === 'tool-call' ? running.status : null, 'in_progress')
  assert.notEqual(ended?.type === 'tool-call' ? ended.status : null, 'in_progress')
})

test('the header counts as many steps as the loaded section draws', () => {
  // The engine's own log keeps the count; the section folds the same log.
  const log = new TranscriptLog()
  const step = (event: ChatEvent): ChatEvent => ({ kind: 'subagent_event', subagentSessionId: 'child-1', event })
  log.append(header(undefined, 0))
  for (const event of [
    message('look'),
    message('ing'),
    { kind: 'agent_thought', text: 'hm' } as ChatEvent,
    { kind: 'tool_call', toolCallId: 't1', title: 'ls', status: 'pending' } as ChatEvent,
    { kind: 'tool_update', toolCallId: 't1', status: 'completed', output: 'a b' } as ChatEvent,
    message('found'),
  ]) {
    log.append(step(event))
  }
  const counted = log.entries()?.[0]
  assert.equal(counted?.kind, 'subagent')
  const steps = counted?.kind === 'subagent' ? counted.subagent.steps : undefined
  assert.equal(foldSectionSteps(log.entries('child-1') ?? [], true).length, steps)
})

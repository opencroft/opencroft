import assert from 'node:assert/strict'
import test from 'node:test'

import type { SessionEntry } from '@/app/_authed/(agent)/_server/agent-sessions-store'
import { toLeaf } from './use-chat-list-nodes'

function session(overrides: Partial<SessionEntry> = {}): SessionEntry {
  return {
    key: 'agent:carol:test',
    agentNodeId: 'agent-1',
    agentName: 'Carol',
    jobNodeId: 'job-1',
    jobName: 'Test Job',
    createdAt: 0,
    ...overrides,
  }
}

const KEY = new Set(['agent:carol:test'])
const NONE = new Set<string>()

test('offline (no live process at all)', () => {
  const leaf = toLeaf(session(), NONE, NONE, NONE, new Map())
  assert.equal(leaf.status, 'offline')
  assert.equal(leaf.hasDraft, false)
})

test('idle (process alive, no active turn)', () => {
  const leaf = toLeaf(session(), NONE, NONE, KEY, new Map())
  assert.equal(leaf.status, 'idle')
})

test('working (turn running)', () => {
  // active implies alive, matching what listSessionActivity actually reports.
  const leaf = toLeaf(session(), NONE, KEY, KEY, new Map())
  assert.equal(leaf.status, 'working')
})

test('waiting (blocked on a permission request)', () => {
  // pending implies alive too.
  const leaf = toLeaf(session(), KEY, NONE, KEY, new Map())
  assert.equal(leaf.status, 'waiting')
})

// Waiting wins if a session were ever somehow flagged as both at once (see the
// comment in toLeaf — in practice this shouldn't happen, but the row's
// approval-needed state must never be masked by the less urgent working state).
test('waiting takes priority over working when both are set', () => {
  const leaf = toLeaf(session(), KEY, KEY, KEY, new Map())
  assert.equal(leaf.status, 'waiting')
})

test('working takes priority over idle when both are set', () => {
  const leaf = toLeaf(session(), NONE, KEY, KEY, new Map())
  assert.equal(leaf.status, 'working')
})

test('hasDraft is true only for a non-blank draft', () => {
  assert.equal(toLeaf(session({ draft: 'unsent text' }), NONE, NONE, NONE, new Map()).hasDraft, true)
  assert.equal(toLeaf(session({ draft: '' }), NONE, NONE, NONE, new Map()).hasDraft, false)
  assert.equal(toLeaf(session({ draft: '   ' }), NONE, NONE, NONE, new Map()).hasDraft, false)
  assert.equal(toLeaf(session({ draft: undefined }), NONE, NONE, NONE, new Map()).hasDraft, false)
})

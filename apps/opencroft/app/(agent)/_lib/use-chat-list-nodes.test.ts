import assert from 'node:assert/strict'
import test from 'node:test'

import type { SessionEntry } from '@/app/(agent)/_server/agent-sessions-store'

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

test('no status dot when neither pending nor active, and no draft', () => {
  const leaf = toLeaf(session(), new Set(), new Set(), new Map())
  assert.equal(leaf.statusIndicator, undefined)
  assert.equal(leaf.hasDraft, false)
})

test('active (turn running) shows the success (green) dot', () => {
  const leaf = toLeaf(session(), new Set(), new Set(['agent:carol:test']), new Map())
  assert.equal(leaf.statusIndicator, 'success')
})

test('pending (blocked on a permission request) shows the primary dot', () => {
  const leaf = toLeaf(session(), new Set(['agent:carol:test']), new Set(), new Map())
  assert.equal(leaf.statusIndicator, 'primary')
})

// Pending wins if a session were ever somehow flagged as both at once (see the
// comment in toLeaf — in practice this shouldn't happen, but the row's
// approval-needed state must never be masked by the less urgent running dot).
test('pending takes priority over active when both are set', () => {
  const leaf = toLeaf(session(), new Set(['agent:carol:test']), new Set(['agent:carol:test']), new Map())
  assert.equal(leaf.statusIndicator, 'primary')
})

test('hasDraft is true only for a non-blank draft', () => {
  assert.equal(toLeaf(session({ draft: 'unsent text' }), new Set(), new Set(), new Map()).hasDraft, true)
  assert.equal(toLeaf(session({ draft: '' }), new Set(), new Set(), new Map()).hasDraft, false)
  assert.equal(toLeaf(session({ draft: '   ' }), new Set(), new Set(), new Map()).hasDraft, false)
  assert.equal(toLeaf(session({ draft: undefined }), new Set(), new Set(), new Map()).hasDraft, false)
})

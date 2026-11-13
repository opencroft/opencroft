import assert from 'node:assert/strict'
import test from 'node:test'

import { mentionCandidates } from './mention-candidates'

test('members with a handle are offered by that handle, in name order', () => {
  const offered = mentionCandidates([
    { kind: 'user', id: 'u1', name: 'Zoe Person', avatarUrl: null, username: 'zoe' },
    { kind: 'agent', id: 'a1', name: 'Bee', avatarUrl: '/avatars/a1', username: 'agent.bee' },
    { kind: 'agent', id: 'a2', name: 'Agent Without Handle', avatarUrl: null, username: null },
  ])
  assert.deepEqual(offered, [
    { handle: 'agent.bee', name: 'Bee', avatarUrl: '/avatars/a1' },
    { handle: 'zoe', name: 'Zoe Person', avatarUrl: null },
  ])
})

import assert from 'node:assert/strict'
import test from 'node:test'

import { countChatThreadKeys } from './session-key'

test("countChatThreadKeys counts one chat's threads in either stored spelling", () => {
  const keys = [
    'group-chat.docs.heidi.first',
    'group-chat:docs:alice:second',
    'group-chat.other.heidi.first',
    'agent:heidi:chat',
    'group-chat.docs.heidi',
  ]
  assert.equal(countChatThreadKeys(keys, 'docs'), 2)
  assert.equal(countChatThreadKeys(keys, 'other'), 1)
})

test('countChatThreadKeys does not match a chat slug that is only a prefix of another', () => {
  assert.equal(countChatThreadKeys(['group-chat.docs-2.heidi.first'], 'docs'), 0)
  assert.equal(countChatThreadKeys(new Set<string>(), 'docs'), 0)
})

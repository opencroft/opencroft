import assert from 'node:assert/strict'
import test from 'node:test'

import { levelsUnderThread } from './thread-levels'

const chatPath = '/group-chats/chat-1'

test('a thread over its own chat needs nothing under it, at either width', () => {
  assert.deepEqual(levelsUnderThread({ below: chatPath, chatPath, bothPanels: true }), [])
  assert.deepEqual(levelsUnderThread({ below: chatPath, chatPath, bothPanels: false }), [])
  assert.deepEqual(levelsUnderThread({ below: `${chatPath}/`, chatPath, bothPanels: false }), [])
})

test('side by side a thread gets its chat under it, wherever it came from', () => {
  for (const below of [undefined, '/group-chats', '/group-chats/', '/group-chats/chat-2/thread-9', '/']) {
    assert.deepEqual(levelsUnderThread({ below, chatPath, bothPanels: true }), ['chat'], String(below))
  }
})

test('below md a thread opened from the chats list gets only its chat, since the list is already under it', () => {
  assert.deepEqual(levelsUnderThread({ below: '/group-chats', chatPath, bothPanels: false }), ['chat'])
  assert.deepEqual(levelsUnderThread({ below: '/group-chats/', chatPath, bothPanels: false }), ['chat'])
})

test('below md a thread from anywhere else gets the chats list and its chat under it', () => {
  for (const below of [undefined, '/', '/group-chats/chat-2', '/group-chats/chat-2/thread-9', `${chatPath}/thread-3`]) {
    assert.deepEqual(levelsUnderThread({ below, chatPath, bothPanels: false }), ['chats', 'chat'], String(below))
  }
})

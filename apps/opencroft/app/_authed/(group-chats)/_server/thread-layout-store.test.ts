import assert from 'node:assert/strict'
import test from 'node:test'

import { readThreadLayout, type ThreadLayout, writeThreadLayout } from './thread-layout-store'

const CHAT = 'chat-a'
const OTHER_CHAT = 'chat-b'

function layout(...threadIds: string[]): ThreadLayout {
  return { entries: threadIds.map((threadId) => ({ kind: 'thread', threadId })) }
}

test('an unarranged chat reads as empty at version 0, which is what a first write expects', async () => {
  const read = await readThreadLayout('never-arranged')
  assert.deepEqual(read.layout, { entries: [] })
  assert.equal(read.version, 0)
})

test('a layout round-trips, and the version moves', async () => {
  const before = await readThreadLayout(CHAT)
  const version = await writeThreadLayout(CHAT, layout('t1', 't2'), before.version)
  assert.notEqual(version, null)

  const after = await readThreadLayout(CHAT)
  assert.deepEqual(after.layout, layout('t1', 't2'))
  assert.equal(after.version, version)
  assert.notEqual(after.version, before.version)
})

test('folders round-trip with their order, names and open state', async () => {
  const withFolder: ThreadLayout = {
    entries: [
      { kind: 'folder', folder: { id: 'f1', name: 'Reviews', open: false, threadIds: ['t2', 't1'] } },
      { kind: 'thread', threadId: 't3' },
    ],
  }
  const before = await readThreadLayout('chat-folders')
  assert.notEqual(await writeThreadLayout('chat-folders', withFolder, before.version), null)
  assert.deepEqual((await readThreadLayout('chat-folders')).layout, withFolder)
})

// The reason this store exists in this shape. Two members reorganise at once:
// both read the same version, both send a full tree. The second must not land.
test('a write against a version someone else has already superseded is refused', async () => {
  const shared = await readThreadLayout('chat-race')

  const first = await writeThreadLayout('chat-race', layout('t1'), shared.version)
  assert.notEqual(first, null, 'the first writer wins')

  const second = await writeThreadLayout('chat-race', layout('t2'), shared.version)
  assert.equal(second, null, 'the second writer is refused rather than clobbering')

  // And the refusal actually protected the data: the first writer's tree is
  // still there. This is the assertion that fails if the write ever stops
  // checking the version -- without it the test would pass on a store that
  // simply returned null for everything.
  assert.deepEqual((await readThreadLayout('chat-race')).layout, layout('t1'))
})

test('after re-reading, the loser of a race can write', async () => {
  const start = await readThreadLayout('chat-recover')
  assert.notEqual(await writeThreadLayout('chat-recover', layout('t1'), start.version), null)
  assert.equal(await writeThreadLayout('chat-recover', layout('t2'), start.version), null)

  const reread = await readThreadLayout('chat-recover')
  assert.notEqual(await writeThreadLayout('chat-recover', layout('t1', 't2'), reread.version), null)
  assert.deepEqual((await readThreadLayout('chat-recover')).layout, layout('t1', 't2'))
})

test('each chat has its own layout', async () => {
  const a = await readThreadLayout(CHAT)
  await writeThreadLayout(CHAT, layout('a1'), a.version)
  const b = await readThreadLayout(OTHER_CHAT)
  await writeThreadLayout(OTHER_CHAT, layout('b1'), b.version)

  assert.deepEqual((await readThreadLayout(CHAT)).layout, layout('a1'))
  assert.deepEqual((await readThreadLayout(OTHER_CHAT)).layout, layout('b1'))
})

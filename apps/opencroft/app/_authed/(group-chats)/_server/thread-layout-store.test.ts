import assert from 'node:assert/strict'
import test from 'node:test'

import type { GroupChatThreadEntry } from '@/app/_authed/(group-chats)/_server/read-model'
import { layoutToNodes, nodesToLayout } from '../_lib/thread-tree-layout'
import {
  folderNameByThreadId,
  MAX_THREAD_LAYOUT_ATTEMPTS,
  readThreadLayout,
  type ThreadLayout,
  updateThreadLayout,
  withThreadInFolder,
  writeThreadLayout,
} from './thread-layout-store'

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

// ── Filing a thread by folder name ─────────────────────────────────────

const ARRANGED: ThreadLayout = {
  entries: [
    { kind: 'folder', folder: { id: 'folder-1', name: 'Reviews', open: false, threadIds: ['t1'] } },
    { kind: 'folder', folder: { id: 'folder-2', name: 'Ops', open: true, threadIds: ['t2'] } },
    { kind: 'thread', threadId: 't3' },
  ],
}

test('a thread is filed at the end of the folder with exactly that name', () => {
  assert.deepEqual(withThreadInFolder(ARRANGED, 't3', 'Reviews'), {
    entries: [
      { kind: 'folder', folder: { id: 'folder-1', name: 'Reviews', open: false, threadIds: ['t1', 't3'] } },
      { kind: 'folder', folder: { id: 'folder-2', name: 'Ops', open: true, threadIds: ['t2'] } },
    ],
  })
})

test('a thread the layout has never seen is filed the same way', () => {
  assert.deepEqual(withThreadInFolder(ARRANGED, 'new', 'Ops'), {
    entries: [
      { kind: 'folder', folder: { id: 'folder-1', name: 'Reviews', open: false, threadIds: ['t1'] } },
      { kind: 'folder', folder: { id: 'folder-2', name: 'Ops', open: true, threadIds: ['t2', 'new'] } },
      { kind: 'thread', threadId: 't3' },
    ],
  })
})

test('with no folder of that name, one is made open after the last folder, with an id nobody holds', () => {
  assert.deepEqual(withThreadInFolder(ARRANGED, 't3', 'Later'), {
    entries: [
      { kind: 'folder', folder: { id: 'folder-1', name: 'Reviews', open: false, threadIds: ['t1'] } },
      { kind: 'folder', folder: { id: 'folder-2', name: 'Ops', open: true, threadIds: ['t2'] } },
      { kind: 'folder', folder: { id: 'folder-3', name: 'Later', open: true, threadIds: ['t3'] } },
    ],
  })
  // Into an unarranged chat: the folder becomes its first entry.
  assert.deepEqual(withThreadInFolder({ entries: [] }, 't1', 'Later'), {
    entries: [{ kind: 'folder', folder: { id: 'folder-1', name: 'Later', open: true, threadIds: ['t1'] } }],
  })
})

test('the name match is exact: a different case is a different folder', () => {
  const next = withThreadInFolder(ARRANGED, 't3', 'reviews')
  assert.deepEqual(
    next?.entries.flatMap((e) => (e.kind === 'folder' ? [`${e.folder.name}:${e.folder.threadIds.join(',')}`] : [])),
    ['Reviews:t1', 'Ops:t2', 'reviews:t3'],
  )
})

test('moving between folders takes the thread out of the old one, which stays even when empty', () => {
  assert.deepEqual(withThreadInFolder(ARRANGED, 't1', 'Ops'), {
    entries: [
      { kind: 'folder', folder: { id: 'folder-1', name: 'Reviews', open: false, threadIds: [] } },
      { kind: 'folder', folder: { id: 'folder-2', name: 'Ops', open: true, threadIds: ['t2', 't1'] } },
      { kind: 'thread', threadId: 't3' },
    ],
  })
})

test('a thread already in that folder needs no write', () => {
  assert.equal(withThreadInFolder(ARRANGED, 't1', 'Reviews'), null)
})

test('each filed thread reports its folder name; a top-level thread reports none', () => {
  assert.deepEqual(
    [...folderNameByThreadId(ARRANGED)],
    [
      ['t1', 'Reviews'],
      ['t2', 'Ops'],
    ],
  )
})

// Parity with a person's move: the thread list draws the placed thread inside
// its folder, and the tree it would write back is the same layout -- nothing in
// the placement is something the list would silently normalise away.
test('the thread list draws a placed thread in its folder and would write the same layout back', () => {
  const placed = withThreadInFolder(ARRANGED, 'new', 'Later')
  assert.ok(placed)
  const threads = ['t1', 't2', 't3', 'new'].map(
    (id): GroupChatThreadEntry => ({
      id,
      groupChatId: CHAT,
      title: id,
      agent: { nodeId: 'node', name: 'Anna', avatarUrl: null },
      createdAt: new Date(0),
      sessionKey: `group-chat.chat.anna.${id}`,
      agentIsMember: true,
      hasDraft: false,
    }),
  )
  const nodes = layoutToNodes(placed, threads, new Map())
  const later = nodes.find((n) => n.type === 'folder' && n.folder.name === 'Later')
  assert.deepEqual(later?.type === 'folder' && later.folder.items.map((i) => i.id), ['new'])
  assert.deepEqual(nodesToLayout(nodes), placed)
})

// ── The operation-based write, and a race during it ──────────────────────

test('a change lands on a chat nobody has arranged yet', async () => {
  await updateThreadLayout('chat-op-fresh', (current) => withThreadInFolder(current, 'new', 'Inbox'))
  assert.deepEqual((await readThreadLayout('chat-op-fresh')).layout, {
    entries: [{ kind: 'folder', folder: { id: 'folder-1', name: 'Inbox', open: true, threadIds: ['new'] } }],
  })
})

test('a change with nothing to do writes nothing', async () => {
  const chat = 'chat-op-noop'
  await writeThreadLayout(chat, ARRANGED, 0)
  const before = await readThreadLayout(chat)
  await updateThreadLayout(chat, (current) => withThreadInFolder(current, 't1', 'Reviews'))
  assert.equal((await readThreadLayout(chat)).version, before.version)
})

// The race to guard against: a person's drag lands between this writer's read
// and its write. The drag must survive, and so must the new thread.
test('a drag that lands mid-write is kept, and the change is re-applied on top of it', async () => {
  const chat = 'chat-op-race'
  await writeThreadLayout(chat, ARRANGED, 0)
  const dragged = withThreadInFolder(ARRANGED, 't3', 'Reviews')
  assert.ok(dragged)
  let reads = 0
  let runs = 0
  await updateThreadLayout(
    chat,
    (current) => {
      runs++
      return withThreadInFolder(current, 'new', 'Ops')
    },
    async (id) => {
      const current = await readThreadLayout(id)
      if (++reads === 1) {
        // A person drags t3 into Reviews after this writer has read.
        assert.notEqual(await writeThreadLayout(id, dragged, current.version), null, 'the drag lands')
      }
      return current
    },
  )
  assert.equal(runs, 2, 'the lost race is re-applied once, against a fresh read')
  assert.deepEqual((await readThreadLayout(chat)).layout, {
    entries: [
      { kind: 'folder', folder: { id: 'folder-1', name: 'Reviews', open: false, threadIds: ['t1', 't3'] } },
      { kind: 'folder', folder: { id: 'folder-2', name: 'Ops', open: true, threadIds: ['t2', 'new'] } },
    ],
  })
})

test('a list contended on every attempt gives up with an error, leaving the last writer standing', async () => {
  const chat = 'chat-op-contended'
  await writeThreadLayout(chat, layout('t1'), 0)
  let runs = 0
  await assert.rejects(
    updateThreadLayout(
      chat,
      (current) => {
        runs++
        return withThreadInFolder(current, 'new', 'Inbox')
      },
      async (id) => {
        const current = await readThreadLayout(id)
        await writeThreadLayout(id, layout(`drag-${runs}`), current.version)
        return current
      },
    ),
    new RegExp(`changed ${MAX_THREAD_LAYOUT_ATTEMPTS} times`),
  )
  assert.equal(runs, MAX_THREAD_LAYOUT_ATTEMPTS)
  assert.deepEqual((await readThreadLayout(chat)).layout, layout(`drag-${MAX_THREAD_LAYOUT_ATTEMPTS - 1}`))
})

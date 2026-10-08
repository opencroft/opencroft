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
  withoutThread,
  withThreadInFolder,
  withThreadPlaced,
  writeThreadLayout,
} from './thread-layout-store'

const CHAT = 'chat-a'
const OTHER_CHAT = 'chat-b'

function layout(...threadIds: string[]): ThreadLayout {
  return { entries: threadIds.map((threadId) => ({ kind: 'thread', threadId })) }
}

test('an unarranged chat reads as empty at version 0, which is what a first write expects', async () => {
  const read = await readThreadLayout('never-arranged', 'active')
  assert.deepEqual(read.layout, { entries: [] })
  assert.equal(read.version, 0)
})

test('a layout round-trips, and the version moves', async () => {
  const before = await readThreadLayout(CHAT, 'active')
  const version = await writeThreadLayout(CHAT, 'active', layout('t1', 't2'), before.version)
  assert.notEqual(version, null)

  const after = await readThreadLayout(CHAT, 'active')
  assert.deepEqual(after.layout, layout('t1', 't2'))
  assert.equal(after.version, version)
  assert.notEqual(after.version, before.version)
})

test('folders round-trip with their order and names', async () => {
  const withFolder: ThreadLayout = {
    entries: [
      { kind: 'folder', folder: { id: 'f1', name: 'Reviews', threadIds: ['t2', 't1'] } },
      { kind: 'thread', threadId: 't3' },
    ],
  }
  const before = await readThreadLayout('chat-folders', 'active')
  assert.notEqual(await writeThreadLayout('chat-folders', 'active', withFolder, before.version), null)
  assert.deepEqual((await readThreadLayout('chat-folders', 'active')).layout, withFolder)
})

// The reason this store exists in this shape. Two members reorganise at once:
// both read the same version, both send a full tree. The second must not land.
test('a write against a version someone else has already superseded is refused', async () => {
  const shared = await readThreadLayout('chat-race', 'active')

  const first = await writeThreadLayout('chat-race', 'active', layout('t1'), shared.version)
  assert.notEqual(first, null, 'the first writer wins')

  const second = await writeThreadLayout('chat-race', 'active', layout('t2'), shared.version)
  assert.equal(second, null, 'the second writer is refused rather than clobbering')

  // And the refusal actually protected the data: the first writer's tree is
  // still there. This is the assertion that fails if the write ever stops
  // checking the version -- without it the test would pass on a store that
  // simply returned null for everything.
  assert.deepEqual((await readThreadLayout('chat-race', 'active')).layout, layout('t1'))
})

test('after re-reading, the loser of a race can write', async () => {
  const start = await readThreadLayout('chat-recover', 'active')
  assert.notEqual(await writeThreadLayout('chat-recover', 'active', layout('t1'), start.version), null)
  assert.equal(await writeThreadLayout('chat-recover', 'active', layout('t2'), start.version), null)

  const reread = await readThreadLayout('chat-recover', 'active')
  assert.notEqual(await writeThreadLayout('chat-recover', 'active', layout('t1', 't2'), reread.version), null)
  assert.deepEqual((await readThreadLayout('chat-recover', 'active')).layout, layout('t1', 't2'))
})

test('each chat has its own layout', async () => {
  const a = await readThreadLayout(CHAT, 'active')
  await writeThreadLayout(CHAT, 'active', layout('a1'), a.version)
  const b = await readThreadLayout(OTHER_CHAT, 'active')
  await writeThreadLayout(OTHER_CHAT, 'active', layout('b1'), b.version)

  assert.deepEqual((await readThreadLayout(CHAT, 'active')).layout, layout('a1'))
  assert.deepEqual((await readThreadLayout(OTHER_CHAT, 'active')).layout, layout('b1'))
})

// The archive is a second list with its own arrangement: writing one must not
// touch the other, and each keeps its own version.
test("a chat's archive layout is separate from its active one, with its own version", async () => {
  const chat = 'chat-two-lists'
  assert.notEqual(await writeThreadLayout(chat, 'active', layout('live'), 0), null)
  assert.equal((await readThreadLayout(chat, 'archive')).version, 0, 'the archive is untouched')
  assert.notEqual(await writeThreadLayout(chat, 'archive', layout('old'), 0), null, 'its first write expects 0')

  assert.deepEqual((await readThreadLayout(chat, 'active')).layout, layout('live'))
  assert.deepEqual((await readThreadLayout(chat, 'archive')).layout, layout('old'))
})

// ── Filing a thread by folder name ─────────────────────────────────────

const ARRANGED: ThreadLayout = {
  entries: [
    { kind: 'folder', folder: { id: 'folder-1', name: 'Reviews', threadIds: ['t1'] } },
    { kind: 'folder', folder: { id: 'folder-2', name: 'Ops', threadIds: ['t2'] } },
    { kind: 'thread', threadId: 't3' },
  ],
}

test('a thread is filed at the end of the folder with exactly that name', () => {
  assert.deepEqual(withThreadInFolder(ARRANGED, 't3', 'Reviews'), {
    entries: [
      { kind: 'folder', folder: { id: 'folder-1', name: 'Reviews', threadIds: ['t1', 't3'] } },
      { kind: 'folder', folder: { id: 'folder-2', name: 'Ops', threadIds: ['t2'] } },
    ],
  })
})

test('a thread the layout has never seen is filed the same way', () => {
  assert.deepEqual(withThreadInFolder(ARRANGED, 'new', 'Ops'), {
    entries: [
      { kind: 'folder', folder: { id: 'folder-1', name: 'Reviews', threadIds: ['t1'] } },
      { kind: 'folder', folder: { id: 'folder-2', name: 'Ops', threadIds: ['t2', 'new'] } },
      { kind: 'thread', threadId: 't3' },
    ],
  })
})

/** The layout with each folder id replaced by `<new>` where it is not one of `known`. */
function maskNewFolderIds(layout: ThreadLayout | null, known: string[]): ThreadLayout | null {
  if (!layout) {
    return null
  }
  return {
    entries: layout.entries.map((entry) =>
      entry.kind === 'folder' && !known.includes(entry.folder.id)
        ? { kind: 'folder', folder: { ...entry.folder, id: '<new>' } }
        : entry,
    ),
  }
}

/** The id of the folder named `name`. */
function folderIdOf(layout: ThreadLayout | null, name: string): string | undefined {
  const entry = layout?.entries.find((e) => e.kind === 'folder' && e.folder.name === name)
  return entry?.kind === 'folder' ? entry.folder.id : undefined
}

test('with no folder of that name, one is made after the last folder, with an id nobody holds', () => {
  assert.deepEqual(maskNewFolderIds(withThreadInFolder(ARRANGED, 't3', 'Later'), ['folder-1', 'folder-2']), {
    entries: [
      { kind: 'folder', folder: { id: 'folder-1', name: 'Reviews', threadIds: ['t1'] } },
      { kind: 'folder', folder: { id: 'folder-2', name: 'Ops', threadIds: ['t2'] } },
      { kind: 'folder', folder: { id: '<new>', name: 'Later', threadIds: ['t3'] } },
    ],
  })
  // Into an unarranged chat: the folder becomes its first entry.
  assert.deepEqual(maskNewFolderIds(withThreadInFolder({ entries: [] }, 't1', 'Later'), []), {
    entries: [{ kind: 'folder', folder: { id: '<new>', name: 'Later', threadIds: ['t1'] } }],
  })
})

// Each reader remembers per folder id whether they left it open. A new folder
// that took a deleted one's id would open or close as that one was left.
test('a new folder never takes the id of one that was deleted', () => {
  const first = withThreadInFolder({ entries: [] }, 't1', 'Later')
  const firstId = folderIdOf(first, 'Later')
  assert.ok(firstId)
  // The folder is deleted: its thread goes loose and the folder is gone.
  const afterDelete: ThreadLayout = { entries: [{ kind: 'thread', threadId: 't1' }] }
  const secondId = folderIdOf(withThreadInFolder(afterDelete, 't1', 'Later'), 'Later')
  assert.ok(secondId)
  assert.notEqual(secondId, firstId)
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
      { kind: 'folder', folder: { id: 'folder-1', name: 'Reviews', threadIds: [] } },
      { kind: 'folder', folder: { id: 'folder-2', name: 'Ops', threadIds: ['t2', 't1'] } },
      { kind: 'thread', threadId: 't3' },
    ],
  })
})

// Two folders may share a name; the thread goes into the first, and only there.
test('with two folders of one name, only the first takes the thread', () => {
  const twins: ThreadLayout = {
    entries: [
      { kind: 'thread', threadId: 't0' },
      { kind: 'folder', folder: { id: 'folder-1', name: 'Ops', threadIds: [] } },
      { kind: 'folder', folder: { id: 'folder-2', name: 'Ops', threadIds: [] } },
    ],
  }
  assert.deepEqual(withThreadInFolder(twins, 't0', 'Ops'), {
    entries: [
      { kind: 'folder', folder: { id: 'folder-1', name: 'Ops', threadIds: ['t0'] } },
      { kind: 'folder', folder: { id: 'folder-2', name: 'Ops', threadIds: [] } },
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

// ── Moving a thread between the active list and the archive ──────────────

test('a thread is taken out of its folder or the top level; a folder it leaves stays', () => {
  assert.deepEqual(withoutThread(ARRANGED, 't1'), {
    entries: [
      { kind: 'folder', folder: { id: 'folder-1', name: 'Reviews', threadIds: [] } },
      { kind: 'folder', folder: { id: 'folder-2', name: 'Ops', threadIds: ['t2'] } },
      { kind: 'thread', threadId: 't3' },
    ],
  })
  assert.deepEqual(withoutThread(ARRANGED, 't3'), {
    entries: [
      { kind: 'folder', folder: { id: 'folder-1', name: 'Reviews', threadIds: ['t1'] } },
      { kind: 'folder', folder: { id: 'folder-2', name: 'Ops', threadIds: ['t2'] } },
    ],
  })
  assert.equal(withoutThread(ARRANGED, 'absent'), null, 'a thread that is not there needs no write')
})

test('a thread placed with a folder name is filed as by name; with none it goes loose at the end', () => {
  assert.deepEqual(withThreadPlaced(ARRANGED, 't9', 'Ops'), withThreadInFolder(ARRANGED, 't9', 'Ops'))
  assert.deepEqual(withThreadPlaced(ARRANGED, 't1', null), {
    entries: [
      { kind: 'folder', folder: { id: 'folder-1', name: 'Reviews', threadIds: [] } },
      { kind: 'folder', folder: { id: 'folder-2', name: 'Ops', threadIds: ['t2'] } },
      { kind: 'thread', threadId: 't3' },
      { kind: 'thread', threadId: 't1' },
    ],
  })
  assert.equal(withThreadPlaced(ARRANGED, 't3', null), null, 'already loose: no write')
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
      archived: false,
    }),
  )
  const nodes = layoutToNodes(placed, threads, new Map(), {})
  const later = nodes.find((n) => n.type === 'folder' && n.folder.name === 'Later')
  assert.deepEqual(later?.type === 'folder' && later.folder.items.map((i) => i.id), ['new'])
  assert.deepEqual(nodesToLayout(nodes), placed)
})

// ── The operation-based write, and a race during it ──────────────────────

test('a change lands on a chat nobody has arranged yet', async () => {
  await updateThreadLayout('chat-op-fresh', 'active', (current) => withThreadInFolder(current, 'new', 'Inbox'))
  assert.deepEqual(maskNewFolderIds((await readThreadLayout('chat-op-fresh', 'active')).layout, []), {
    entries: [{ kind: 'folder', folder: { id: '<new>', name: 'Inbox', threadIds: ['new'] } }],
  })
})

test('a change with nothing to do writes nothing', async () => {
  const chat = 'chat-op-noop'
  await writeThreadLayout(chat, 'active', ARRANGED, 0)
  const before = await readThreadLayout(chat, 'active')
  await updateThreadLayout(chat, 'active', (current) => withThreadInFolder(current, 't1', 'Reviews'))
  assert.equal((await readThreadLayout(chat, 'active')).version, before.version)
})

// The race to guard against: a person's drag lands between this writer's read
// and its write. The drag must survive, and so must the new thread.
test('a drag that lands mid-write is kept, and the change is re-applied on top of it', async () => {
  const chat = 'chat-op-race'
  await writeThreadLayout(chat, 'active', ARRANGED, 0)
  const dragged = withThreadInFolder(ARRANGED, 't3', 'Reviews')
  assert.ok(dragged)
  let reads = 0
  let runs = 0
  await updateThreadLayout(
    chat,
    'active',
    (current) => {
      runs++
      return withThreadInFolder(current, 'new', 'Ops')
    },
    async (id, list) => {
      const current = await readThreadLayout(id, list)
      if (++reads === 1) {
        // A person drags t3 into Reviews after this writer has read.
        assert.notEqual(await writeThreadLayout(id, list, dragged, current.version), null, 'the drag lands')
      }
      return current
    },
  )
  assert.equal(runs, 2, 'the lost race is re-applied once, against a fresh read')
  assert.deepEqual((await readThreadLayout(chat, 'active')).layout, {
    entries: [
      { kind: 'folder', folder: { id: 'folder-1', name: 'Reviews', threadIds: ['t1', 't3'] } },
      { kind: 'folder', folder: { id: 'folder-2', name: 'Ops', threadIds: ['t2', 'new'] } },
    ],
  })
})

test('a list contended on every attempt gives up with an error, leaving the last writer standing', async () => {
  const chat = 'chat-op-contended'
  await writeThreadLayout(chat, 'active', layout('t1'), 0)
  let runs = 0
  await assert.rejects(
    updateThreadLayout(
      chat,
      'active',
      (current) => {
        runs++
        return withThreadInFolder(current, 'new', 'Inbox')
      },
      async (id, list) => {
        const current = await readThreadLayout(id, list)
        await writeThreadLayout(id, list, layout(`drag-${runs}`), current.version)
        return current
      },
    ),
    new RegExp(`changed ${MAX_THREAD_LAYOUT_ATTEMPTS} times`),
  )
  assert.equal(runs, MAX_THREAD_LAYOUT_ATTEMPTS)
  assert.deepEqual((await readThreadLayout(chat, 'active')).layout, layout(`drag-${MAX_THREAD_LAYOUT_ATTEMPTS - 1}`))
})

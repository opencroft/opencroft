import assert from 'node:assert/strict'
import test from 'node:test'

import type { ChatListNode } from 'ui/chat/chat-list'

import type { ThreadRowStateById } from '@/app/_authed/(group-chats)/_lib/thread-row-state'
import type { GroupChatThreadEntry } from '@/app/_authed/(group-chats)/_server/read-model'
import type { ThreadLayout } from '@/app/_authed/(group-chats)/_server/thread-layout-store'
import { layoutToNodes, nodesToLayout, threadLeaf } from './thread-tree-layout'

function thread(id: string, over: Partial<GroupChatThreadEntry> = {}): GroupChatThreadEntry {
  return {
    id,
    groupChatId: 'chat-1',
    title: `Thread ${id}`,
    agent: { nodeId: `node-${id}`, name: 'Anna', avatarUrl: null },
    createdAt: new Date(0),
    sessionKey: `group-chat:chat-1:anna:${id}`,
    agentIsMember: true,
    hasDraft: false,
    archived: false,
    ...over,
  }
}

const NO_STATUS: ThreadRowStateById = new Map()
const HALF_FULL = { usedTokens: 100_000, contextLimit: 200_000 }

/** The ids a rendered tree contains, folders written as `name[a,b]`. */
function shape(nodes: ChatListNode[]): string[] {
  return nodes.map((n) =>
    n.type === 'item' ? n.item.id : `${n.folder.name}[${n.folder.items.map((i) => i.id).join(',')}]`,
  )
}

const EMPTY: ThreadLayout = { entries: [] }

test('an unarranged chat lists every thread loose, in the order the server gave them', () => {
  const nodes = layoutToNodes(EMPTY, [thread('t1'), thread('t2'), thread('t3')], NO_STATUS)
  assert.deepEqual(shape(nodes), ['t1', 't2', 't3'])
})

test('a saved arrangement is honoured, folders and all', () => {
  const layout: ThreadLayout = {
    entries: [
      { kind: 'folder', folder: { id: 'f1', name: 'Reviews', open: false, threadIds: ['t3', 't1'] } },
      { kind: 'thread', threadId: 't2' },
    ],
  }
  const nodes = layoutToNodes(layout, [thread('t1'), thread('t2'), thread('t3')], NO_STATUS)
  assert.deepEqual(shape(nodes), ['Reviews[t3,t1]', 't2'])
  assert.equal(nodes[0].type === 'folder' && nodes[0].folder.open, false)
})

test('a layout entry whose thread is gone is dropped, loose and inside a folder alike', () => {
  const layout: ThreadLayout = {
    entries: [
      { kind: 'folder', folder: { id: 'f1', name: 'Reviews', threadIds: ['gone-1', 't1'] } },
      { kind: 'thread', threadId: 'gone-2' },
      { kind: 'thread', threadId: 't2' },
    ],
  }
  const nodes = layoutToNodes(layout, [thread('t1'), thread('t2')], NO_STATUS)
  assert.deepEqual(shape(nodes), ['Reviews[t1]', 't2'])
})

test('a thread the layout has never seen joins the loose list at the end', () => {
  const layout: ThreadLayout = {
    entries: [
      { kind: 'folder', folder: { id: 'f1', name: 'Reviews', threadIds: ['t2'] } },
      { kind: 'thread', threadId: 't1' },
    ],
  }
  const nodes = layoutToNodes(layout, [thread('t1'), thread('t2'), thread('new')], NO_STATUS)
  assert.deepEqual(shape(nodes), ['Reviews[t2]', 't1', 'new'])
})

// The folder is something a person made and named. Dropping it because its last
// thread was deleted would take away the place they file the next one into.
test('a folder left empty by deletions is kept', () => {
  const layout: ThreadLayout = {
    entries: [{ kind: 'folder', folder: { id: 'f1', name: 'Reviews', threadIds: ['gone'] } }],
  }
  const nodes = layoutToNodes(layout, [thread('t1')], NO_STATUS)
  assert.deepEqual(shape(nodes), ['Reviews[]', 't1'])
})

test('a live thread carries its agent, its pushed status and its context reading', () => {
  const leaf = threadLeaf(thread('t1', { hasDraft: true }), { status: 'working', context: HALF_FULL })
  assert.equal(leaf.description, 'Anna')
  assert.equal(leaf.status, 'working')
  assert.deepEqual(leaf.context, HALF_FULL)
  assert.equal(leaf.disabled, false)
  assert.equal(leaf.hasDraft, true)
})

// All three of these were decided for the list this replaces, and are carried
// over rather than re-derived. The status one is the discriminating case: the
// activity still reports a state for the session, and the row must not show it.
test('a removed agent dims the row, says so, and shows no status or reading even when one is pushed', () => {
  const leaf = threadLeaf(thread('t1', { agentIsMember: false }), { status: 'working', context: HALF_FULL })
  assert.equal(leaf.description, 'Anna · agent removed')
  assert.equal(leaf.status, undefined)
  assert.equal(leaf.context, undefined)
  assert.equal(leaf.disabled, true)
})

test('an untitled thread still gets a title', () => {
  assert.equal(threadLeaf(thread('t1', { title: null }), undefined).title, 'Untitled')
})

// What makes the store's "nothing here can go stale" claim true.
test('the tree is stored as a skeleton, with no titles, avatars, status, readings or drafts in it', () => {
  const nodes = layoutToNodes(
    EMPTY,
    [thread('t1', { hasDraft: true }), thread('t2')],
    new Map([['t1', { status: 'waiting' as const, context: HALF_FULL }]]),
  )
  const saved = nodesToLayout(nodes)
  assert.deepEqual(saved, {
    entries: [
      { kind: 'thread', threadId: 't1' },
      { kind: 'thread', threadId: 't2' },
    ],
  })
  assert.ok(!JSON.stringify(saved).includes('Thread t1'))
  assert.ok(!JSON.stringify(saved).includes('waiting'))
})

test('a folder round-trips through the tree and back to a layout', () => {
  const layout: ThreadLayout = {
    entries: [
      { kind: 'folder', folder: { id: 'f1', name: 'Reviews', open: false, threadIds: ['t2'] } },
      { kind: 'thread', threadId: 't1' },
    ],
  }
  const back = nodesToLayout(layoutToNodes(layout, [thread('t1'), thread('t2')], NO_STATUS))
  assert.deepEqual(back, layout)
})

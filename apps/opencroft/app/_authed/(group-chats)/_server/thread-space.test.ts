// Which space a session key's thread belongs to, against a real database: the
// thread found live or through a freed key, its chat read at its slug (then at
// the slugs a chat rename freed), and that slug read as a space address, live or
// through a freed space slug.
import '@opencroft/db/test-env'

import assert from 'node:assert/strict'
import test from 'node:test'

import {
  db,
  groupChat,
  groupChatSlugAlias,
  groupChatThread,
  groupChatThreadAlias,
  space,
  spaceSlugAlias,
} from '@opencroft/db'

import { spaceIdBySlug, spaceIdForSessionKey } from './thread-space'

async function seedChat(slug: string): Promise<string> {
  const [chat] = await db.insert(groupChat).values({ slug, name: slug, topic: slug }).returning({ id: groupChat.id })
  return chat.id
}

async function seedThread(chatId: string, sessionKey: string): Promise<string> {
  const [thread] = await db
    .insert(groupChatThread)
    .values({ groupChatId: chatId, agentNodeId: 'agent-a', sessionKey })
    .returning({ id: groupChatThread.id })
  return thread.id
}

test("a thread's key resolves to the space at its chat's slug", async () => {
  const [row] = await db.insert(space).values({ slug: 'space-live', name: 'Space' }).returning({ id: space.id })
  await seedThread(await seedChat('space-live'), 'group-chat.space-live.agent-a.thread-1')

  assert.equal(await spaceIdForSessionKey('group-chat.space-live.agent-a.thread-1'), row.id)
})

test('a key a thread rename freed still resolves, through the thread alias', async () => {
  const [row] = await db.insert(space).values({ slug: 'space-thread-alias', name: 'Space' }).returning({ id: space.id })
  const chatId = await seedChat('space-thread-alias')
  const threadId = await seedThread(chatId, 'group-chat.space-thread-alias.agent-a.renamed')
  await db.insert(groupChatThreadAlias).values({
    threadId,
    groupChatId: chatId,
    agentNodeId: 'agent-a',
    sessionKey: 'group-chat.space-thread-alias.agent-a.original',
  })

  assert.equal(await spaceIdForSessionKey('group-chat.space-thread-alias.agent-a.original'), row.id)
})

test("a renamed space keeps its chat: the chat's slug resolves through the space's alias", async () => {
  const [row] = await db.insert(space).values({ slug: 'space-new-name', name: 'Space' }).returning({ id: space.id })
  await db.insert(spaceSlugAlias).values({ slug: 'space-old-name', spaceId: row.id })
  await seedThread(await seedChat('space-old-name'), 'group-chat.space-old-name.agent-a.thread-1')

  assert.equal(await spaceIdBySlug('space-old-name'), row.id)
  assert.equal(await spaceIdForSessionKey('group-chat.space-old-name.agent-a.thread-1'), row.id)
})

test("a space's chat renamed away from the space's slug still resolves, through the chat's alias", async () => {
  const [row] = await db.insert(space).values({ slug: 'space-chat-renamed', name: 'Space' }).returning({ id: space.id })
  const chatId = await seedChat('space-chat-renamed-team')
  await db.insert(groupChatSlugAlias).values({ slug: 'space-chat-renamed', groupChatId: chatId })
  await seedThread(chatId, 'group-chat.space-chat-renamed-team.agent-a.thread-1')

  assert.equal(await spaceIdForSessionKey('group-chat.space-chat-renamed-team.agent-a.thread-1'), row.id)
})

test("a chat's live slug outranks its aliases, and aliases naming two spaces resolve to none", async () => {
  const [live] = await db.insert(space).values({ slug: 'space-live-wins', name: 'Space' }).returning({ id: space.id })
  await db.insert(space).values({ slug: 'space-alias-loses', name: 'Space' })
  const liveChatId = await seedChat('space-live-wins')
  await db.insert(groupChatSlugAlias).values({ slug: 'space-alias-loses', groupChatId: liveChatId })
  await seedThread(liveChatId, 'group-chat.space-live-wins.agent-a.thread-1')

  await db.insert(space).values([
    { slug: 'space-ambiguous-a', name: 'Space' },
    { slug: 'space-ambiguous-b', name: 'Space' },
  ])
  const sharedChatId = await seedChat('chat-ambiguous')
  await db.insert(groupChatSlugAlias).values([
    { slug: 'space-ambiguous-a', groupChatId: sharedChatId },
    { slug: 'space-ambiguous-b', groupChatId: sharedChatId },
  ])
  await seedThread(sharedChatId, 'group-chat.chat-ambiguous.agent-a.thread-1')

  assert.equal(await spaceIdForSessionKey('group-chat.space-live-wins.agent-a.thread-1'), live.id)
  assert.equal(await spaceIdForSessionKey('group-chat.chat-ambiguous.agent-a.thread-1'), null)
})

test('a chat at no space address, and a key no thread holds, resolve to no space', async () => {
  await seedThread(await seedChat('chat-without-space'), 'group-chat.chat-without-space.agent-a.thread-1')

  assert.equal(await spaceIdForSessionKey('group-chat.chat-without-space.agent-a.thread-1'), null)
  assert.equal(await spaceIdForSessionKey('group-chat.nowhere.agent-a.thread-1'), null)
  assert.equal(await spaceIdBySlug('nowhere'), null)
})

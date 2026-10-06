// The migration that gives every recorded usage turn the space it was spent
// in, run for real: the schema as it stood before it, turns in every shape the
// backfill has a rule for, then the migration itself — and which space each
// turn holds afterwards.
import assert from 'node:assert/strict'
import { cpSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import test, { after, before } from 'node:test'

import { PGlite } from '@electric-sql/pglite'
import { drizzle } from 'drizzle-orm/pglite'
import { migrate } from 'drizzle-orm/pglite/migrator'

import { migrationsFolder } from './connect'

const MIGRATION = '0054_chat_usage_turn_space'

interface Journal {
  entries: Array<{ tag: string }>
}

let client: PGlite
let beforeMigration: string

// The migrations folder as it stood just before this migration: the same files,
// with the journal ending one entry earlier.
function foldersBefore(tag: string): string {
  const dir = mkdtempSync(path.join(tmpdir(), 'chat-usage-turn-space-'))
  cpSync(migrationsFolder, dir, { recursive: true })
  const journalFile = path.join(dir, 'meta', '_journal.json')
  const journal = JSON.parse(readFileSync(journalFile, 'utf-8')) as Journal
  const at = journal.entries.findIndex((entry) => entry.tag === tag)
  assert.ok(at > 0, `${tag} is in the journal`)
  writeFileSync(journalFile, JSON.stringify({ ...journal, entries: journal.entries.slice(0, at) }))
  return dir
}

before(async () => {
  beforeMigration = foldersBefore(MIGRATION)
  client = new PGlite()
  await migrate(drizzle(client), { migrationsFolder: beforeMigration })
})

after(async () => {
  await client?.close()
  rmSync(beforeMigration, { recursive: true, force: true })
})

const now = new Date().toISOString()

async function insertSpace(id: string, slug: string) {
  await client.query(`INSERT INTO "Space" (id, slug, name, "createdAt", "updatedAt") VALUES ($1, $2, $2, $3, $3)`, [
    id,
    slug,
    now,
  ])
}

async function insertChat(id: string, slug: string) {
  await client.query(
    `INSERT INTO "GroupChat" (id, slug, name, topic, "createdAt", "updatedAt") VALUES ($1, $2, $2, $2, $3, $3)`,
    [id, slug, now],
  )
}

async function insertChatAlias(id: string, slug: string, chatId: string) {
  await client.query(
    `INSERT INTO "GroupChatSlugAlias" (id, slug, "groupChatId", "createdAt") VALUES ($1, $2, $3, $4)`,
    [id, slug, chatId, now],
  )
}

async function insertThread(id: string, chatId: string, sessionKey: string) {
  await client.query(
    `INSERT INTO "GroupChatThread" (id, "groupChatId", "agentNodeId", "sessionKey", "createdAt")
     VALUES ($1, $2, 'agent-a', $3, $4)`,
    [id, chatId, sessionKey, now],
  )
}

async function insertTurn(id: string, sessionId: string, sessionKey: string | null) {
  await client.query(
    `INSERT INTO "ChatUsageTurn"
       (id, day, "sessionId", "sessionKey", "adapterId", "inputTokens", "outputTokens",
        "cacheReadTokens", "cacheWriteTokens", "totalTokens", "createdAt")
     VALUES ($1, '2026-01-01', $2, $3, 'adapter', 0, 0, 0, 0, 1, $4)`,
    [id, sessionId, sessionKey, now],
  )
}

async function insertBackgroundTask(taskId: string, sessionId: string, sessionKey: string) {
  await client.query(
    `INSERT INTO "BackgroundTask"
       ("taskId", "instanceId", "sessionKey", "sessionId", kind, name, target, summary, state, "startedAt")
     VALUES ($1, 'instance-1', $2, $3, 'tool', 'task', 'target', 'summary', 'done', $4)`,
    [taskId, sessionKey, sessionId, now],
  )
}

test('each turn takes the space its session resolves to, and a turn nothing resolves keeps none', async () => {
  // Two spaces, each with its own chat at its slug. The second was renamed:
  // its chat still sits at the old slug, which the space keeps as an alias.
  await insertSpace('space-1', 'one')
  await insertChat('chat-1', 'one')
  await insertSpace('space-2', 'two-renamed')
  await client.query(
    `INSERT INTO "SpaceSlugAlias" (id, slug, "spaceId", "createdAt") VALUES ('alias-s', 'two', 'space-2', $1)`,
    [now],
  )
  await insertChat('chat-2', 'two')
  // A renamed chat: its old slug is an alias.
  await insertChatAlias('alias-c', 'one-old', 'chat-1')
  // A chat at no space's address.
  await insertChat('chat-free', 'free-chat')
  // A space's chat renamed away from the space's slug: the space still reaches
  // it through the chat's alias.
  await insertSpace('space-3', 'three')
  await insertChat('chat-3', 'three-team')
  await insertChatAlias('alias-c3', 'three', 'chat-3')
  // A chat whose aliases name two spaces: both reach it, so neither is credited.
  await insertSpace('space-4', 'four')
  await insertSpace('space-5', 'five')
  await insertChat('chat-45', 'four-and-five')
  await insertChatAlias('alias-c4', 'four', 'chat-45')
  await insertChatAlias('alias-c5', 'five', 'chat-45')
  // A chat whose live slug addresses a space: that outranks its aliases.
  await insertSpace('space-6', 'six')
  await insertSpace('space-7', 'seven')
  await insertChat('chat-6', 'six')
  await insertChatAlias('alias-c7', 'seven', 'chat-6')

  await insertThread('thread-1', 'chat-1', 'group-chat.one.agent-a.live')
  await client.query(
    `INSERT INTO "GroupChatThreadAlias" (id, "threadId", "groupChatId", "agentNodeId", "sessionKey", "createdAt")
     VALUES ('alias-t', 'thread-1', 'chat-1', 'agent-a', 'group-chat.one.agent-a.before-rename', $1)`,
    [now],
  )
  await insertThread('thread-2', 'chat-2', 'group-chat.two.agent-a.live')
  await insertThread('thread-free', 'chat-free', 'group-chat.free-chat.agent-a.live')
  await insertThread('thread-3', 'chat-3', 'group-chat.three-team.agent-a.live')
  await insertThread('thread-45', 'chat-45', 'group-chat.four-and-five.agent-a.live')
  await insertThread('thread-6', 'chat-6', 'group-chat.six.agent-a.live')

  await insertTurn('live-thread', 'sess-1', 'group-chat.one.agent-a.live')
  await insertTurn('aliased-thread', 'sess-2', 'group-chat.one.agent-a.before-rename')
  await insertTurn('renamed-space', 'sess-3', 'group-chat.two.agent-a.live')
  // Threads since deleted: the key's own chat segment, live and aliased.
  await insertTurn('deleted-thread', 'sess-4', 'group-chat.one.agent-a.gone')
  await insertTurn('deleted-thread-old-chat-slug', 'sess-5', 'group-chat.one-old.agent-a.gone')
  await insertTurn('chat-at-no-space', 'sess-6', 'group-chat.free-chat.agent-a.live')
  await insertTurn('unknown-key', 'sess-7', 'group-chat.no-such-chat.agent-a.gone')
  await insertTurn('renamed-chat', 'sess-11', 'group-chat.three-team.agent-a.live')
  await insertTurn('chat-aliased-by-two-spaces', 'sess-12', 'group-chat.four-and-five.agent-a.live')
  await insertTurn('chat-live-slug-wins', 'sess-13', 'group-chat.six.agent-a.live')
  // Keyless turns, recovered through another record of the same session id.
  await insertTurn('keyless-sibling-turn', 'sess-1', null)
  await insertTurn('keyless-background-task', 'sess-8', null)
  await insertBackgroundTask('task-1', 'sess-8', 'group-chat.two.agent-a.live')
  await insertTurn('keyless-two-spaces', 'sess-9', null)
  await insertBackgroundTask('task-2', 'sess-9', 'group-chat.one.agent-a.live')
  await insertBackgroundTask('task-3', 'sess-9', 'group-chat.two.agent-a.live')
  await insertTurn('keyless-alone', 'sess-10', null)

  await migrate(drizzle(client), { migrationsFolder })

  const rows = await client.query<{ id: string; spaceId: string | null }>(
    `SELECT id, "spaceId" FROM "ChatUsageTurn" ORDER BY id`,
  )
  assert.deepEqual(Object.fromEntries(rows.rows.map((row) => [row.id, row.spaceId])), {
    'aliased-thread': 'space-1',
    'chat-aliased-by-two-spaces': null,
    'chat-at-no-space': null,
    'chat-live-slug-wins': 'space-6',
    'deleted-thread': 'space-1',
    'deleted-thread-old-chat-slug': 'space-1',
    'keyless-alone': null,
    'keyless-background-task': 'space-2',
    'keyless-sibling-turn': 'space-1',
    'keyless-two-spaces': null,
    'live-thread': 'space-1',
    'renamed-chat': 'space-3',
    'renamed-space': 'space-2',
    'unknown-key': null,
  })
  const leftovers = await client.query(`SELECT 1 FROM pg_tables WHERE tablename = 'ChatUsageTurnKeySpace'`)
  assert.equal(leftovers.rows.length, 0, 'the working table is dropped')
})

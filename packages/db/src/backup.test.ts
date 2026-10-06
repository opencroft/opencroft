// What a backup COVERS, against a real database.
//
// The defect this suite exists to prevent is not a crash. A hand-written table
// list went four years' worth of schema growth out of date — twenty-three of
// the twenty-seven tables were missing, including every graph — and produced
// backups that restored without an error and without the data. So the first
// assertions here are about coverage, derived from the schema module
// independently of the list under test, and the rest are a round trip through
// PGlite proving the covered rows actually survive one.
import './test-env'

import assert from 'node:assert/strict'
import test, { after, before, beforeEach } from 'node:test'

import { getTableName, is, sql } from 'drizzle-orm'
import { PgTable } from 'drizzle-orm/pg-core'

import {
  allTableNames,
  type Backup,
  backedUpTableNames,
  backupSource,
  createBackup,
  excludedTableNames,
  resetDatabase,
  restoreBackup,
} from './backup'
import { type DB, openDb } from './connect'
import * as schema from './schema'

let db: DB
let close: () => Promise<void>

before(async () => {
  ;({ db, close } = await openDb())
})

after(async () => {
  await close?.()
})

beforeEach(async () => {
  if (db) {
    await resetDatabase(db)
  }
})

function declaredTableNames(): string[] {
  const names = new Set<string>()
  for (const value of Object.values(schema as Record<string, unknown>)) {
    if (is(value, PgTable)) {
      names.add(getTableName(value))
    }
  }
  return [...names].sort()
}

test('every table the schema declares is either backed up or named as excluded', () => {
  // Derived from the schema module here, so this compares the list under test
  // against the thing it claims to follow rather than against itself.
  const declared = new Set(declaredTableNames())
  const accounted = new Set([...backedUpTableNames(), ...excludedTableNames()])
  assert.deepEqual(
    [...declared].filter((name) => !accounted.has(name)).sort(),
    [],
    'a table exists that no backup would carry and nothing declares excluded',
  )
  assert.deepEqual(
    [...accounted].filter((name) => !declared.has(name)).sort(),
    [],
    'the backup names a table the schema no longer has',
  )
  assert.deepEqual(allTableNames().slice().sort(), [...declared].sort())
})

test('the tables the four-table list silently dropped are covered', () => {
  // Named one by one rather than by count: these are the ones whose absence
  // was invisible, and a reader should be able to see them listed.
  const covered = new Set(backedUpTableNames())
  for (const name of [
    'SpaceGraph',
    'SpaceApp',
    'SpaceSlugAlias',
    'GroupChat',
    'GroupChatThread',
    'GroupChatThreadArtifact',
    'AgentQueueEntry',
    'AgentSessionEvent',
    'ChatAttachment',
    'ChatUsageTurn',
    'UsageRollupDay',
    'ApiToken',
    'Username',
    'user',
    'account',
  ]) {
    assert.ok(covered.has(name), `${name} is not in the backup`)
  }
})

test('only the two credential tables are excluded, and they are still reset', () => {
  assert.deepEqual(excludedTableNames().slice().sort(), ['session', 'verification'])
  const all = new Set(allTableNames())
  assert.ok(all.has('session') && all.has('verification'))
})

test('a table is ordered after every table it points at', () => {
  const position = new Map(backedUpTableNames().map((name, index) => [name, index]))
  const pairs: [string, string][] = [
    ['SpaceGraph', 'Space'],
    ['SpaceApp', 'Space'],
    ['account', 'user'],
    ['ApiToken', 'user'],
    ['GroupChatThread', 'GroupChat'],
    ['GroupChatThreadAlias', 'GroupChatThread'],
    ['ChatUsageTurnModel', 'ChatUsageTurn'],
  ]
  for (const [child, parent] of pairs) {
    const childAt = position.get(child)
    const parentAt = position.get(parent)
    assert.ok(childAt !== undefined && parentAt !== undefined, `${child}/${parent} missing from the order`)
    assert.ok(childAt > parentAt, `${child} is inserted before ${parent}, which its foreign key needs`)
  }
})

async function seed(): Promise<void> {
  await db.insert(schema.setting).values({ id: 'extension-storage', data: '{"design-kit::x":1}', version: 7 })
  await db.insert(schema.user).values({ id: 'u1', name: 'Admin', email: 'admin@example.test', role: 'admin' })
  await db
    .insert(schema.account)
    .values({ id: 'a1', accountId: 'u1', providerId: 'credential', userId: 'u1', password: 'hash' })
  await db.insert(schema.space).values({ id: 's1', slug: 'default', name: 'Default', pinned: true })
  await db.insert(schema.spaceGraph).values({
    id: 'g1',
    spaceId: 's1',
    instanceId: 'i1',
    slug: 'default',
    name: 'Default',
    data: '{"nodes":[1],"edges":[]}',
  })
  await db
    .insert(schema.spaceApp)
    .values({ id: 'app1', spaceId: 's1', type: 'builtin.core.graph', name: 'Graph', slug: 'graph' })
  await db
    .insert(schema.agentSessionEvent)
    .values({ sessionKey: 'k1', position: 0, event: { type: 'turn_end', usage: { input: 1 } } })
  await db.insert(schema.chatUsageTurn).values({
    id: 't1',
    day: '2026-09-22',
    sessionId: 'k1',
    adapterId: 'claude',
    inputTokens: 9_007_199_254,
    outputTokens: 2,
    cacheReadTokens: 3,
    cacheWriteTokens: 4,
    totalTokens: 5,
    costAmount: 1.25,
  })
}

test('a backup round-trips the tables the old list never carried', async () => {
  await seed()
  const backup = await createBackup(db)
  // Through JSON, because that is what a backup file is: a Date that only
  // survives in memory would pass an assertion the real path fails.
  const onDisk = JSON.parse(JSON.stringify(backup)) as Backup
  await resetDatabase(db)
  assert.equal((await db.select().from(schema.spaceGraph)).length, 0)

  const summary = await restoreBackup(db, backupSource(onDisk))

  const graphs = await db.select().from(schema.spaceGraph)
  assert.equal(graphs.length, 1)
  assert.equal(graphs[0].data, '{"nodes":[1],"edges":[]}')
  assert.equal(graphs[0].spaceId, 's1')
  const apps = await db.select().from(schema.spaceApp)
  assert.equal(apps.length, 1)
  const users = await db.select().from(schema.user)
  assert.equal(users[0]?.role, 'admin')
  const accounts = await db.select().from(schema.account)
  assert.equal(accounts[0]?.password, 'hash')
  assert.equal(summary.restored.SpaceGraph, 1)
  assert.deepEqual(summary.unknown, [])
})

test('column types survive the JSON crossing', async () => {
  await seed()
  const onDisk = JSON.parse(JSON.stringify(await createBackup(db))) as Backup
  await resetDatabase(db)
  await restoreBackup(db, backupSource(onDisk))

  const [setting] = await db.select().from(schema.setting)
  assert.ok(setting.createdAt instanceof Date, 'timestamp came back as a string')
  assert.equal(setting.version, 7)
  const [space] = await db.select().from(schema.space)
  assert.equal(space.pinned, true)
  const [event] = await db.select().from(schema.agentSessionEvent)
  assert.deepEqual(event.event, { type: 'turn_end', usage: { input: 1 } })
  const [turn] = await db.select().from(schema.chatUsageTurn)
  // Past 2^32, so a bigint that had been narrowed to int would not come back.
  assert.equal(turn.inputTokens, 9_007_199_254)
  assert.equal(turn.costAmount, 1.25)
})

test('a generated column is left out of a backup and computed again on restore', async () => {
  await db.insert(schema.transcriptMessage).values({
    sessionKey: 'k1',
    position: 0,
    segment: 0,
    role: 'user',
    turn: 0,
    text: 'restored words',
    createdAt: new Date(),
  })
  const onDisk = JSON.parse(JSON.stringify(await createBackup(db))) as Backup
  assert.deepEqual(Object.keys(onDisk.tables.TranscriptMessage?.[0] ?? {}).sort(), [
    'createdAt',
    'position',
    'role',
    'segment',
    'sessionKey',
    'text',
    'turn',
  ])
  await resetDatabase(db)

  await restoreBackup(db, backupSource(onDisk))

  const [entry] = await db.select().from(schema.transcriptMessage)
  assert.equal(entry?.document, "'restored':1 'words':2")
})

// The extension folders in a backup are snapshots or checkouts without their
// install record; this table is where each came from and, through createdAt,
// which of two local copies of one extension is served. A restore that lost
// either would reinstall from nowhere or flip which copy wins.
test('an extension row keeps its source and the time it first appeared through a backup', async () => {
  const row = {
    folder: 'acme.widgets',
    sourceUrl: 'https://git.example.com/acme/widgets.git',
    registryName: 'default',
    authStoreId: 'store-1',
    authUsernameKey: 'user',
    authTokenKey: 'token',
    ref: 'v1.2.0',
    commit: '0123456789abcdef0123456789abcdef01234567',
    createdAt: new Date('2026-01-02T03:04:05.000Z'),
    updatedAt: new Date('2026-02-03T04:05:06.000Z'),
  }
  await db.insert(schema.extension).values(row)
  const onDisk = JSON.parse(JSON.stringify(await createBackup(db))) as Backup
  assert.ok('Extension' in onDisk.tables, 'the table is carried')
  await resetDatabase(db)
  assert.deepEqual(await db.select().from(schema.extension), [])

  await restoreBackup(db, backupSource(onDisk))

  assert.deepEqual(await db.select().from(schema.extension), [row])
})

test('a backup that covers only some tables leaves the rest alone', async () => {
  // The shape of every v1 file in data/backups: four tables, written when the
  // schema had four. Restoring one must not be read as "the other twenty-three
  // are empty" -- what it says is nothing at all about them.
  await seed()
  const v1: Backup = {
    formatVersion: 1,
    createdAt: new Date().toISOString(),
    tables: { Setting: [{ id: 'active-space-slug', data: '"default"' }] },
  }

  const summary = await restoreBackup(db, backupSource(v1))

  const settings = await db.select().from(schema.setting)
  assert.deepEqual(
    settings.map((row) => row.id),
    ['active-space-slug'],
    'the covered table was not replaced',
  )
  assert.equal((await db.select().from(schema.spaceGraph)).length, 1, 'an uncovered table was emptied')
  assert.ok(summary.uncovered.includes('SpaceGraph'))
  assert.deepEqual(summary.restored, { Setting: 1 })
})

test('a stored row carrying a column the schema has since dropped still loads', async () => {
  // drizzle builds an insert from the keys it is handed and looks each one up
  // on the table, so an unknown key is not ignored -- it throws. The old
  // comment claimed otherwise; this is the assertion that makes it true.
  const backup: Backup = {
    formatVersion: 1,
    createdAt: new Date().toISOString(),
    tables: { Space: [{ id: 's9', slug: 'old', name: 'Old', retiredColumn: 'gone' }] },
  }

  await restoreBackup(db, backupSource(backup))

  const spaces = await db.select().from(schema.space)
  assert.equal(spaces.length, 1)
  assert.equal(spaces[0].slug, 'old')
})

test('a stored space without an icon takes a random preset', async () => {
  // Every space has had an icon since the column became required; a backup
  // taken before then carries null, or no icon key at all.
  const backup: Backup = {
    formatVersion: 1,
    createdAt: new Date().toISOString(),
    tables: {
      Space: [
        { id: 's7', slug: 'null-icon', name: 'Null Icon', icon: null },
        { id: 's8', slug: 'no-icon', name: 'No Icon' },
      ],
    },
  }

  await restoreBackup(db, backupSource(backup))

  const spaces = await db.select().from(schema.space)
  assert.equal(spaces.length, 2)
  for (const space of spaces) {
    assert.match(space.icon, /^preset:[a-z-]+:[a-z]+$/)
  }
})

test('a key naming no table is reported rather than restored', async () => {
  const summary = await restoreBackup(
    db,
    backupSource({
      formatVersion: 1,
      createdAt: new Date().toISOString(),
      tables: { NoSuchTable: [{ id: 'x' }] },
    }),
  )
  assert.deepEqual(summary.unknown, ['NoSuchTable'])
  assert.deepEqual(summary.restored, {})
})

test('a file that is not a backup is refused before a restore can start', () => {
  assert.throws(() => backupSource({ formatVersion: 1 } as unknown as Backup), /missing tables/)
})

test('a restore asks the source once per covered table and inserts every row across insert batches', async () => {
  // More rows than one insert statement carries, so the batch boundary and the
  // remainder after it are both crossed.
  const settings = Array.from({ length: 2_345 }, (_, i) => ({ id: `setting-${i}`, data: `"${i}"` }))
  let asked: string[] = []

  const summary = await restoreBackup(db, {
    tables: ['Setting'],
    async *rows(table) {
      asked = [...asked, table]
      yield* settings
    },
  })

  assert.deepEqual(asked, ['Setting'])
  assert.equal(summary.restored.Setting, settings.length)
  assert.equal((await db.select().from(schema.setting)).length, settings.length)
})

// The embedded PGlite builds a whole result in its wasm memory: four rows this
// size in one SELECT ran it out of memory, and every query after failed until
// the process restarted. The backup runs on a schedule, so reading the
// attachment table in one SELECT would take a running instance down by itself.
test('six attachments at the size ceiling back up and restore, and the database stays usable', async () => {
  // About 4 MiB of image as base64, the most the attachment store admits.
  const data = 'R'.repeat(Math.floor((4 * 1024 * 1024 * 4) / 3))
  const ids = ['a1', 'a2', 'a3', 'a4', 'a5', 'a6']
  for (const id of ids) {
    await db.insert(schema.chatAttachment).values({
      id,
      sessionKey: 'agent:test:backup',
      name: `${id}.gif`,
      mimeType: 'image/gif',
      data,
      byteSize: Math.floor((data.length * 3) / 4),
    })
  }
  const backup = await createBackup(db)
  assert.deepEqual(
    backup.tables.ChatAttachment.map((row) => [row.id, (row.data as string).length]),
    ids.map((id) => [id, data.length]),
  )
  await resetDatabase(db)
  const summary = await restoreBackup(db, backupSource(JSON.parse(JSON.stringify(backup)) as Backup))
  assert.equal(summary.restored.ChatAttachment, 6)
  const restored = await db
    .select({ id: schema.chatAttachment.id, byteSize: schema.chatAttachment.byteSize })
    .from(schema.chatAttachment)
  assert.deepEqual(restored.map((row) => row.id).sort(), ids, 'a query after the round trip still runs')
})

test('tables whose rows add up past one SELECT back up and restore, whatever their key', async () => {
  // Two 10 MB messages in the queue (a single-column key) and about 23 MiB of
  // session events (a composite key). Either table in one SELECT would run
  // the embedded database out of memory, and the restore's inserts are held
  // to the same budget.
  const message = 'm'.repeat(10 * 1024 * 1024)
  for (const id of ['entry-a', 'entry-b']) {
    await db
      .insert(schema.agentQueueEntry)
      .values({ id, sessionKey: 'agent:test:big', kind: 'message', text: message, position: 0 })
  }
  const filler = 'e'.repeat(20 * 1024)
  for (let start = 0; start < 1_200; start += 100) {
    await db.insert(schema.agentSessionEvent).values(
      Array.from({ length: 100 }, (_, i) => ({
        sessionKey: 'agent:test:big',
        position: start + i,
        event: { kind: 'agent_message', text: filler },
      })),
    )
  }

  const backup = await createBackup(db)
  assert.deepEqual(
    backup.tables.AgentQueueEntry.map((row) => [row.id, (row.text as string).length]),
    [
      ['entry-a', message.length],
      ['entry-b', message.length],
    ],
  )
  assert.equal(backup.tables.AgentSessionEvent.length, 1_200)

  await resetDatabase(db)
  const summary = await restoreBackup(db, backupSource(backup))
  assert.deepEqual([summary.restored.AgentQueueEntry, summary.restored.AgentSessionEvent], [2, 1_200])
  const { rows } = await db.execute(sql`
    select
      (select count(*)::int from "AgentQueueEntry" where length(text) = ${message.length}) as entries,
      (select count(*)::int from "AgentSessionEvent") as events`)
  assert.deepEqual(rows, [{ entries: 2, events: 1_200 }], 'a query after the round trip still runs')
})

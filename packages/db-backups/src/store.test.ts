// The product path, end to end: take a backup, change the world, put it back.
//
// Everything below this file is covered in isolation — the dump against a real
// PGlite in @opencroft/db, the container against Python's zipfile, the walker
// against a real tree. What only this file covers is the two halves moving
// together: a backup taken by `createBackupFile` and applied by
// `restoreBackupFile`, with both the database and the data directory changed
// in between.
import assert from 'node:assert/strict'
import {
  copyFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test, { after, before, beforeEach } from 'node:test'

const workdir = mkdtempSync(join(tmpdir(), 'opencroft-backup-store-test-'))
const dataDirectory = join(workdir, 'data')

// Set BEFORE the store is imported: it reads OPENCROFT_DATA_DIR at module
// scope, and importing @opencroft/db opens the database during evaluation. A
// static import of either would have been resolved before any of this ran.
process.env.OPENCROFT_DATA_DIR = dataDirectory
process.env.PGLITE_PATH = join(workdir, 'pglite')
delete process.env.DATABASE_URL

mkdirSync(dataDirectory, { recursive: true })

const { db, setting, space, spaceGraph } = await import('@opencroft/db')
const { closeDb } = await import('@opencroft/db')
const { resetDatabase } = await import('@opencroft/db/backup')
const store = await import('./store')

const instanceDir = join(dataDirectory, 'app-data', 'local', 'design-kit', 'inst-1')

after(async () => {
  await closeDb()
  rmSync(workdir, { recursive: true, force: true })
})

before(() => {
  mkdirSync(join(dataDirectory, 'backups'), { recursive: true })
})

beforeEach(async () => {
  await resetDatabase(db)
  rmSync(join(dataDirectory, 'app-data'), { recursive: true, force: true })
  mkdirSync(join(instanceDir, 'components'), { recursive: true })
  writeFileSync(join(instanceDir, 'components', 'button.tsx'), 'v1\n')
  writeFileSync(join(instanceDir, 'registry.json'), '{"components":["button"]}\n')
  await db.insert(setting).values({ id: 'extension-storage', data: '{"design-kit::draft":"kept"}' })
  await db.insert(space).values({ id: 's1', slug: 'default', name: 'Default' })
  await db
    .insert(spaceGraph)
    .values({ id: 'g1', spaceId: 's1', instanceId: 'i1', slug: 'default', name: 'Default', data: '{"nodes":[1]}' })
})

test('a backup is a .zip and lists as one', async () => {
  const info = await store.createBackupFile()

  assert.match(info.filename, /^backup-\d{4}-\d{2}-\d{2}_\d{2}-\d{2}-\d{2}\.zip$/)
  assert.equal(info.format, 'zip')
  assert.ok(info.sizeBytes > 0)
  const listed = await store.listBackupFiles()
  assert.ok(listed.some((file) => file.filename === info.filename))
})

test('it says what it holds without applying any of it', async () => {
  const info = await store.createBackupFile()

  const contents = await store.describeBackupFile(info.filename)

  assert.equal(contents.format, 'zip')
  assert.equal(contents.tables.SpaceGraph, 1)
  assert.equal(contents.tables.Space, 1)
  assert.equal(contents.tables.Setting, 1)
  assert.ok(contents.fileRoots.includes('app-data'))
})

test('a restore puts back both the graph and the app storage', async () => {
  const info = await store.createBackupFile()

  // The world moves on: the graph is edited, extension storage is edited, a
  // component is rewritten and another is added.
  await db.update(spaceGraph).set({ data: '{"nodes":[1,2,3]}' })
  await db.update(setting).set({ data: '{"design-kit::draft":"clobbered"}' })
  writeFileSync(join(instanceDir, 'components', 'button.tsx'), 'v2-EDITED\n')
  writeFileSync(join(instanceDir, 'components', 'added-after.tsx'), 'new\n')

  const result = await store.restoreBackupFile(info.filename)

  const [graph] = await db.select().from(spaceGraph)
  assert.equal(graph.data, '{"nodes":[1]}', 'the graph was not restored')
  const [stored] = await db.select().from(setting)
  assert.equal(stored.data, '{"design-kit::draft":"kept"}', "the extension's stored data was not restored")
  assert.equal(readFileSync(join(instanceDir, 'components', 'button.tsx'), 'utf8'), 'v1\n')
  assert.ok(
    !existsSync(join(instanceDir, 'components', 'added-after.tsx')),
    'app storage was merged rather than replaced',
  )
  assert.ok(result.restoredRoots.includes('app-data'))
  assert.equal(result.restored.SpaceGraph, 1)
})

test('a damaged archive is refused with the database untouched', async () => {
  const info = await store.createBackupFile()
  const file = join(dataDirectory, 'backups', info.filename)
  const bytes = readFileSync(file)
  // A tenth off the end: enough to take the central directory AND the
  // checksum trailer, which is what a transfer cut short actually looks like.
  writeFileSync(file, bytes.subarray(0, Math.floor(bytes.length * 0.9)))
  await db.update(spaceGraph).set({ data: '{"nodes":[9,9,9]}' })

  await assert.rejects(() => store.restoreBackupFile(info.filename))

  const [graph] = await db.select().from(spaceGraph)
  assert.equal(graph.data, '{"nodes":[9,9,9]}', 'a failed restore changed the database anyway')
})

test('an upload that is not a backup is refused rather than listed', async () => {
  const before = (await store.listBackupFiles()).length

  await assert.rejects(() => store.saveUploadedBackup(Buffer.from('not a zip at all'), 'evil.zip'))

  assert.equal((await store.listBackupFiles()).length, before, 'a rejected upload was left in the list')
})

test('a downloaded archive uploads back and restores', async () => {
  const info = await store.createBackupFile()
  const bytes = await store.readBackupFileBuffer(info.filename)
  await store.deleteBackupFile(info.filename)

  const uploaded = await store.saveUploadedBackup(bytes, 'backup-from-elsewhere.zip')

  assert.equal(uploaded.format, 'zip')
  await db.update(spaceGraph).set({ data: '{}' })
  await store.restoreBackupFile(uploaded.filename)
  const [graph] = await db.select().from(spaceGraph)
  assert.equal(graph.data, '{"nodes":[1]}')
})

test('a v1 .json backup still restores, and says what it does not carry', async () => {
  // Older installs still keep backups like this in data/backups. The
  // shape is the one the four-table dump wrote.
  const legacy = {
    formatVersion: 1,
    createdAt: '2026-09-18T22:56:08.000Z',
    tables: { Setting: [{ id: 'active-space-slug', data: '"other"' }] },
  }
  writeFileSync(join(dataDirectory, 'backups', 'backup-old.json'), JSON.stringify(legacy))

  const contents = await store.describeBackupFile('backup-old.json')
  const result = await store.restoreBackupFile('backup-old.json')

  assert.equal(contents.format, 'json')
  assert.deepEqual(contents.fileRoots, [])
  const settings = await db.select().from(setting)
  assert.deepEqual(
    settings.map((row) => row.id),
    ['active-space-slug'],
  )
  assert.equal(result.filesWritten, 0, 'a .json backup wrote files it does not contain')
  assert.ok(result.uncovered.includes('SpaceGraph'))
  // It carries no Space rows either, so nothing cascades and the graph stands.
  assert.equal((await db.select().from(spaceGraph)).length, 1)
})

test('a format 2 archive, with its rows in one database.json, still restores', async () => {
  // Written by the format 2 writer itself, not rebuilt here, so this holds the
  // reader to what such an archive actually contains.
  copyFileSync(
    new URL('./fixtures/backup-v2.zip', import.meta.url),
    join(dataDirectory, 'backups', 'backup-format-2.zip'),
  )

  const contents = await store.describeBackupFile('backup-format-2.zip')
  const result = await store.restoreBackupFile('backup-format-2.zip')

  assert.equal(contents.formatVersion, 2)
  assert.deepEqual(result.restored, { Space: 1, SpaceGraph: 1 })
  const [graph] = await db.select().from(spaceGraph)
  assert.equal(graph.data, '{"nodes":["v2"]}')
  assert.equal(
    readFileSync(join(dataDirectory, 'app-data', 'local', 'sample-app', 'inst-1', 'notes.txt'), 'utf8'),
    'v2-content\n',
  )
  assert.ok(!existsSync(instanceDir), 'app storage was merged rather than replaced')
})

test('backups started together each restore to their own manifest', async () => {
  // Both stage their rows under the same directory with the same file names,
  // so without the queue one archive can carry the other's rows.
  const first = store.createBackupFile()
  await db.insert(setting).values([
    { id: 'added-between-1', data: '"x"' },
    { id: 'added-between-2', data: '"y"' },
  ])
  const second = store.createBackupFile()
  const third = store.createBackupFile()

  const infos = await Promise.all([first, second, third])

  assert.equal(new Set(infos.map((info) => info.filename)).size, 3, 'one backup replaced another')
  for (const info of infos) {
    const contents = await store.describeBackupFile(info.filename)
    const result = await store.restoreBackupFile(info.filename)
    assert.deepEqual(result.restored, contents.tables, info.filename)
  }
})

test('a restore leaves no staged rows behind', async () => {
  const info = await store.createBackupFile()

  await store.restoreBackupFile(info.filename)

  const backupsDir = join(dataDirectory, 'backups')
  assert.deepEqual(
    readdirSync(backupsDir).filter((name) => name.startsWith('.')),
    [],
    'a staging directory outlived the restore',
  )
})

test('an upload is filed by its bytes, not by the name the browser sent', async () => {
  const info = await store.createBackupFile()
  const bytes = await store.readBackupFileBuffer(info.filename)

  const uploaded = await store.saveUploadedBackup(bytes, 'someone-renamed-this.json')

  assert.equal(uploaded.format, 'zip', 'an archive was filed as a legacy dump because of its name')
  assert.match(uploaded.filename, /\.zip$/)
  assert.equal((await store.describeBackupFile(uploaded.filename)).format, 'zip')
})

test('a failed write leaves nothing in the listing', async () => {
  const before = (await store.listBackupFiles()).length

  await assert.rejects(() => store.saveUploadedBackup(Buffer.from('PK not really'), 'broken.zip'))

  const after = await store.listBackupFiles()
  assert.equal(after.length, before)
  assert.ok(
    !after.some((file) => file.filename.startsWith('broken')),
    'a rejected upload is visible as a restorable backup',
  )
})

test('a filename that is not a plain name is refused', async () => {
  for (const name of ['../../etc/passwd', '/etc/passwd', 'a/b.zip', 'backup.zip/../x', 'backup.txt']) {
    await assert.rejects(() => store.restoreBackupFile(name), /Invalid backup filename/, name)
  }
})

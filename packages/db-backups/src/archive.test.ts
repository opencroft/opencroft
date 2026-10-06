// The archive as a whole: what it carries, what it refuses, and what a
// restore does to the disk.
//
// The file half is exercised against a real directory tree with the shapes
// that actually caused trouble — an empty directory nobody would think to
// preserve, a git checkout with ignored build output next to uncommitted
// work, a symlink — because those are the cases a walker gets wrong.
import assert from 'node:assert/strict'
import { constants } from 'node:buffer'
import { spawnSync } from 'node:child_process'
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test, { after, beforeEach } from 'node:test'

import type { BackupSource } from '@opencroft/db/backup'

import {
  ARCHIVE_FORMAT_VERSION,
  extractBackupFiles,
  readArchiveManifest,
  readBackupArchive,
  TRAILER_MEMBER,
  writeBackupArchive,
} from './archive'
import { stageDatabaseDump, stagedDumpSource } from './database-dump'
import { BACKUP_FILE_ROOTS, type FileRoot } from './file-tree'
import { readZip, writeZip, type ZipMember } from './zip'

/** Every member of an archive, in order. Six call sites wrote this inline. */
async function collect(archive: string): Promise<ZipMember[]> {
  const members: ZipMember[] = []
  await readZip(archive, (member) => {
    members.push(member)
  })
  return members
}

const pathsIn = async (archive: string) => (await collect(archive)).map((member) => member.path)

const workdir = mkdtempSync(join(tmpdir(), 'opencroft-archive-test-'))
const dataDirectory = join(workdir, 'data')

after(() => {
  rmSync(workdir, { recursive: true, force: true })
})

const git = (cwd: string, ...args: string[]) =>
  spawnSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@t', '-c', 'commit.gpgsign=false', ...args], {
    cwd,
    encoding: 'utf8',
  })

const hasGit = spawnSync('git', ['--version'], { encoding: 'utf8' }).status === 0

const ROOTS: readonly FileRoot[] = [
  { name: 'app-data', policy: 'all' },
  { name: 'extensions', policy: 'git-aware' },
]

type Rows = Record<string, Record<string, unknown>[]>

const SAMPLE_ROWS: Rows = {
  Space: [{ id: 's1', slug: 'default', name: 'Default' }],
  SpaceGraph: [{ id: 'g1', spaceId: 's1', slug: 'default', name: 'Default', data: '{"nodes":[]}' }],
}

let scratch = 0
/** A fresh directory under the test's workdir, for a dump to be staged in. */
const scratchDirectory = () => join(workdir, `scratch-${scratch++}`)

/** `rows` staged the way a real backup stages them, ready for `writeBackupArchive`. */
async function sampleDatabase(rows: Rows = SAMPLE_ROWS, memberBytes?: number) {
  const database = await stageDatabaseDump(
    scratchDirectory(),
    Object.keys(rows),
    async function* (table) {
      yield* rows[table]
    },
    memberBytes,
  )
  return { createdAt: '2026-09-22T17:00:00.000Z', database }
}

/** Every row a restore would be handed, by table. */
async function rowsOf(database: BackupSource): Promise<Rows> {
  const out: Rows = {}
  for (const table of database.tables) {
    out[table] = []
    for await (const row of database.rows(table)) {
      out[table].push(row)
    }
  }
  return out
}

/** A data directory with the shapes a walker gets wrong. */
function buildDataDirectory(): void {
  rmSync(dataDirectory, { recursive: true, force: true })

  const instance = join(dataDirectory, 'app-data', 'local', 'design-kit', 'inst-1')
  mkdirSync(join(instance, 'components'), { recursive: true })
  writeFileSync(join(instance, 'components', 'button.tsx'), 'export const Button = () => null\n')
  writeFileSync(join(instance, 'registry.json'), '{"components":["button"]}\n')
  // An App instance whose data directory exists and is empty — the instance
  // still has one, and a restore that loses it loses that fact.
  mkdirSync(join(dataDirectory, 'app-data', 'local', 'git', 'inst-2'), { recursive: true })

  writeExtensionFolder(join(dataDirectory, 'extensions', 'local.sample-ext'), '.gitignore')
  // A registry install: a snapshot of one commit, so no .git and no .gitignore.
  writeExtensionFolder(join(dataDirectory, 'extensions', 'acme.snapshot'))
}

/** The shape of an extension folder: sources, a vendored binary, and what a build leaves behind. */
function writeExtensionFolder(folder: string, ignoreFile?: string): void {
  mkdirSync(join(folder, 'src'), { recursive: true })
  mkdirSync(join(folder, 'node_modules', 'left-pad'), { recursive: true })
  mkdirSync(join(folder, 'dist'), { recursive: true })
  mkdirSync(join(folder, 'assets', 'vad'), { recursive: true })
  if (ignoreFile) {
    writeFileSync(join(folder, ignoreFile), 'node_modules/\ndist/\nassets/vad/\n')
  }
  writeFileSync(join(folder, 'package.json'), '{"name":"sample-ext"}\n')
  writeFileSync(join(folder, 'src', 'index.ts'), 'export const x = 1\n')
  writeFileSync(join(folder, 'node_modules', 'left-pad', 'index.js'), 'module.exports = 1\n')
  writeFileSync(join(folder, 'dist', 'server.js'), 'built\n')
  writeFileSync(join(folder, 'assets', 'vad', 'model.onnx'), 'x'.repeat(4096))
}

beforeEach(() => {
  buildDataDirectory()
})

test('the manifest is the first member and reads on its own', async () => {
  const archive = join(workdir, 'manifest-first.zip')
  await writeBackupArchive(archive, { ...(await sampleDatabase()), dataDirectory, roots: ROOTS })

  const seen: string[] = []
  await readZip(archive, (member) => {
    seen.push(member.path)
    return seen.length < 2
  })
  assert.equal(seen[0], 'manifest.json')

  const manifest = await readArchiveManifest(archive)
  assert.equal(manifest.formatVersion, ARCHIVE_FORMAT_VERSION)
  assert.deepEqual(manifest.database.tables, { Space: 1, SpaceGraph: 1 })
  assert.equal(manifest.database.totalRows, 2)
  assert.deepEqual(manifest.fileRoots, ['app-data', 'extensions'])
  // Dependency order, not alphabetical: `session` points at `user` and
  // `verification` points at nothing, so the dump's order puts the second first.
  assert.deepEqual(manifest.database.excludedTables.slice().sort(), ['session', 'verification'])
})

test('the database half survives the archive unchanged', async () => {
  const archive = join(workdir, 'database.zip')
  await writeBackupArchive(archive, { ...(await sampleDatabase()), dataDirectory, roots: ROOTS })

  const { database } = await readBackupArchive(archive, scratchDirectory())

  assert.deepEqual(await rowsOf(database), SAMPLE_ROWS)
})

test('the rows are cut into bounded members and come back whole and in order', async () => {
  // Scaled down: a 1 KiB bound standing in for the real one, with one row
  // bigger than the bound on its own. A member may pass the bound by at most
  // the row that took it over; nothing ever holds a whole table.
  const memberBytes = 1024
  const rows: Rows = {
    Space: Array.from({ length: 40 }, (_, i) => ({ id: `space-${i}`, slug: `s-${i}`, name: 'x'.repeat(i * 7) })),
    ChatAttachment: [
      { id: 'a1', data: 'R'.repeat(5000) },
      { id: 'a2', data: 'line one\nline two' },
    ],
    SpaceGraph: [],
  }
  const largestRow = Math.max(
    ...Object.values(rows)
      .flat()
      .map((row) => Buffer.byteLength(`${JSON.stringify(row)}\n`)),
  )
  const archive = join(workdir, 'bounded.zip')
  await writeBackupArchive(archive, { ...(await sampleDatabase(rows, memberBytes)), dataDirectory, roots: ROOTS })

  const members = (await collect(archive)).filter((member) => member.path.startsWith('database/'))
  assert.ok(members.filter((member) => member.path.startsWith('database/Space/')).length > 1, 'a table was not split')
  for (const member of members) {
    assert.ok(member.data.length < memberBytes + largestRow, `${member.path} is ${member.data.length} bytes`)
  }
  const manifest = await readArchiveManifest(archive)
  assert.deepEqual(manifest.database.tables, { Space: 40, ChatAttachment: 2, SpaceGraph: 0 })
  const { database } = await readBackupArchive(archive, scratchDirectory())
  // An empty table is still covered: restoring it is the claim that it is empty.
  assert.deepEqual(database.tables, ['Space', 'ChatAttachment', 'SpaceGraph'])
  assert.deepEqual(await rowsOf(database), rows)
})

test('rows that do not add up to the manifest count are refused once read', async () => {
  const { database } = await sampleDatabase()
  const source = stagedDumpSource({ ...database, tables: { ...database.tables, Space: 2 } })

  await assert.rejects(() => rowsOf(source), /holds 1 Space rows where its manifest says 2/)
})

test('a dump past the V8 string limit writes and reads back', async () => {
  // A hundred attachments at the 4 MiB ceiling, about 5.6 MB of base64 each.
  // One string holding them all is past what V8 will make, so a dump
  // serialised in one piece cannot carry them. The rows share one string, so
  // the test itself holds 5.6 MB rather than 560.
  const data = 'R'.repeat(Math.ceil((4 * 1024 * 1024 * 4) / 3))
  const rows: Rows = { ChatAttachment: Array.from({ length: 100 }, (_, i) => ({ id: `attachment-${i}`, data })) }
  assert.ok(100 * data.length > constants.MAX_STRING_LENGTH, 'the fixture no longer crosses the string limit')
  const archive = join(workdir, 'past-the-limit.zip')

  await writeBackupArchive(archive, { ...(await sampleDatabase(rows)), dataDirectory, roots: ROOTS })

  const { manifest, database } = await readBackupArchive(archive, scratchDirectory())
  assert.equal(manifest.database.totalRows, 100)
  let restored = 0
  for await (const row of database.rows('ChatAttachment')) {
    assert.equal(row.id, `attachment-${restored}`)
    assert.equal(row.data, data)
    restored++
  }
  assert.equal(restored, 100)
})

test('an empty App instance directory is carried', async () => {
  const archive = join(workdir, 'empty-dir.zip')
  await writeBackupArchive(archive, { ...(await sampleDatabase()), dataDirectory, roots: ROOTS })

  const paths: string[] = []
  await readZip(archive, (member) => {
    paths.push(member.path)
  })

  assert.ok(paths.includes('files/app-data/local/git/inst-2/'), 'an instance directory with no files in it was dropped')
})

test('a git checkout carries its source and skips what a clone rebuilds', {
  skip: hasGit ? false : 'git unavailable',
}, async () => {
  const checkout = join(dataDirectory, 'extensions', 'local.sample-ext')
  git(checkout, 'init', '-q')
  git(checkout, 'add', '.')
  git(checkout, 'commit', '-qm', 'first')
  // Uncommitted work, which is the whole reason the worktree is carried at all.
  writeFileSync(join(checkout, 'src', 'wip.ts'), 'export const wip = true\n')

  const archive = join(workdir, 'checkout.zip')
  await writeBackupArchive(archive, { ...(await sampleDatabase()), dataDirectory, roots: ROOTS })

  const paths = new Set(await pathsIn(archive))

  const base = 'files/extensions/local.sample-ext/'
  assert.ok(paths.has(`${base}src/index.ts`), 'a tracked file was dropped')
  assert.ok(paths.has(`${base}src/wip.ts`), 'uncommitted work was dropped')
  assert.ok(
    [...paths].some((p) => p.startsWith(`${base}.git/`)),
    '.git was dropped, losing unpushed commits',
  )
  assert.ok(!paths.has(`${base}node_modules/left-pad/index.js`), 'node_modules was carried')
  assert.ok(!paths.has(`${base}dist/server.js`), 'build output was carried')
  assert.ok(!paths.has(`${base}assets/vad/model.onnx`), 'a gitignored vendored binary was carried')
})

test('a checkout that is not a git repository falls back to a static exclude list', async () => {
  // No `git init` in this one: the fallback must still drop what is rebuilt
  // rather than give up and take everything.
  const archive = join(workdir, 'no-git.zip')
  await writeBackupArchive(archive, { ...(await sampleDatabase()), dataDirectory, roots: ROOTS })

  const paths = new Set(await pathsIn(archive))

  const base = 'files/extensions/local.sample-ext/'
  assert.ok(paths.has(`${base}src/index.ts`))
  assert.ok(!paths.has(`${base}node_modules/left-pad/index.js`))
  assert.ok(!paths.has(`${base}dist/server.js`))
  // Not gitignored here, because there is no git — the static list is narrower
  // on purpose, and the trade is stated rather than hidden.
  assert.ok(paths.has(`${base}assets/vad/model.onnx`))
})

test('one root carries a checkout and a registry snapshot each by its own rule', {
  skip: hasGit ? false : 'git unavailable',
}, async () => {
  const checkout = join(dataDirectory, 'extensions', 'local.sample-ext')
  git(checkout, 'init', '-q')
  git(checkout, 'add', '.')
  git(checkout, 'commit', '-qm', 'first')
  const archive = join(workdir, 'mixed-extensions.zip')
  await writeBackupArchive(archive, { ...(await sampleDatabase()), dataDirectory, roots: ROOTS })

  const paths = new Set(await pathsIn(archive))

  // The checkout: git decides, and its history comes along.
  assert.ok([...paths].some((p) => p.startsWith('files/extensions/local.sample-ext/.git/')))
  assert.ok(!paths.has('files/extensions/local.sample-ext/assets/vad/model.onnx'), 'git ignores the binary')
  // The snapshot has no .git to ask, so only the rebuildable directories go;
  // what its source does not ignore, a backup keeps because nothing else can
  // say whether the source is still there to fetch it from.
  const snapshot = 'files/extensions/acme.snapshot/'
  assert.ok(paths.has(`${snapshot}src/index.ts`))
  assert.ok(paths.has(`${snapshot}package.json`))
  assert.ok(paths.has(`${snapshot}assets/vad/model.onnx`))
  assert.ok(!paths.has(`${snapshot}node_modules/left-pad/index.js`), 'node_modules was carried')
  assert.ok(!paths.has(`${snapshot}dist/server.js`), 'build output was carried')
})

test('a folder an install is staging or has parked is not carried', async () => {
  // Copies of an extension that also exists under its real name; one may be
  // half-written when the backup runs.
  for (const transient of ['.staging-acme.snapshot-1-1', '.old-acme.snapshot-1-1']) {
    mkdirSync(join(dataDirectory, 'extensions', transient, 'src'), { recursive: true })
    writeFileSync(join(dataDirectory, 'extensions', transient, 'src', 'index.ts'), 'export const x = 2\n')
  }
  const archive = join(workdir, 'transient.zip')

  const { trailer } = await writeBackupArchive(archive, { ...(await sampleDatabase()), dataDirectory, roots: ROOTS })

  const paths = await pathsIn(archive)
  assert.ok(!paths.some((p) => p.includes('.staging-') || p.includes('.old-')), 'a transient folder was carried')
  assert.ok(paths.includes('files/extensions/acme.snapshot/src/index.ts'), 'the real folder is still carried')
  assert.deepEqual(
    trailer.skipped.filter((entry) => entry.reason === 'transient').map((entry) => entry.path),
    ['.old-acme.snapshot-1-1', '.staging-acme.snapshot-1-1'],
  )
})

test('the roots a real backup takes are the single extensions root, not a local subtree', () => {
  const extensions = BACKUP_FILE_ROOTS.filter((root) => root.name.startsWith('extensions'))

  assert.deepEqual(extensions, [{ name: 'extensions', policy: 'git-aware' }])
})

test('a symlink is recorded as skipped rather than followed', async () => {
  symlinkSync('/etc', join(dataDirectory, 'app-data', 'escape'))
  const archive = join(workdir, 'symlink.zip')

  const { trailer } = await writeBackupArchive(archive, { ...(await sampleDatabase()), dataDirectory, roots: ROOTS })

  assert.deepEqual(
    trailer.skipped.filter((entry) => entry.reason === 'symlink').map((entry) => entry.path),
    ['escape'],
  )
  const paths = await pathsIn(archive)
  assert.ok(!paths.some((p) => p.includes('escape')), 'a symlink was followed out of the data directory')
})

test('a damaged member is refused before anything is applied', async () => {
  const archive = join(workdir, 'damaged.zip')
  await writeBackupArchive(archive, { ...(await sampleDatabase()), dataDirectory, roots: ROOTS })

  // Rebuild the archive with one member's contents swapped for something of
  // the same length: the container is intact, every CRC and length agrees,
  // and only the SHA-256 in the trailer can tell.
  const members = await collect(archive)
  const target = members.find((member) => member.path.endsWith('registry.json'))
  assert.ok(target, 'fixture changed: no registry.json in the archive')
  target.data = Buffer.alloc(target.data.length, 0x20)
  const tampered = join(workdir, 'tampered.zip')
  await writeZip(tampered, members)

  await assert.rejects(() => readBackupArchive(tampered, scratchDirectory()), /fails its checksum/)
})

test('an archive without its trailer is refused as truncated', async () => {
  const archive = join(workdir, 'no-trailer.zip')
  await writeBackupArchive(archive, { ...(await sampleDatabase()), dataDirectory, roots: ROOTS })
  const members = await collect(archive)
  const withoutTrailer = join(workdir, 'without-trailer.zip')
  await writeZip(
    withoutTrailer,
    members.filter((member) => member.path !== TRAILER_MEMBER),
  )

  await assert.rejects(() => readBackupArchive(withoutTrailer, scratchDirectory()), /no checksums.json|truncated/)
})

test('a member that escapes its root is refused', async () => {
  const hostile = join(workdir, 'hostile.zip')
  await writeZip(hostile, [
    {
      path: 'manifest.json',
      data: Buffer.from(JSON.stringify({ formatVersion: 2, fileRoots: ['app-data'] })),
    },
    { path: 'files/app-data/../../../escaped.txt', data: Buffer.from('owned') },
  ])

  await assert.rejects(
    () =>
      extractBackupFiles(hostile, dataDirectory, {
        manifest: { fileRoots: ['app-data'] },
        trailer: { executables: [] },
      } as never),
    /escapes its root/,
  )
  assert.ok(!existsSync(join(workdir, 'escaped.txt')))
})

test('restoring replaces a root rather than merging into it', async () => {
  const archive = join(workdir, 'replace.zip')
  const { manifest, trailer } = await writeBackupArchive(archive, {
    ...(await sampleDatabase()),
    dataDirectory,
    roots: ROOTS,
  })

  // The disk moves on after the backup: a file is added, another is changed.
  const instance = join(dataDirectory, 'app-data', 'local', 'design-kit', 'inst-1')
  writeFileSync(join(instance, 'components', 'added-later.tsx'), 'later\n')
  writeFileSync(join(instance, 'registry.json'), 'CHANGED\n')

  const result = await extractBackupFiles(archive, dataDirectory, { manifest, trailer })

  assert.ok(result.files > 0)
  assert.equal(readFileSync(join(instance, 'registry.json'), 'utf8'), '{"components":["button"]}\n')
  assert.ok(
    !existsSync(join(instance, 'components', 'added-later.tsx')),
    'a file absent from the backup survived the restore, so the root was merged rather than replaced',
  )
  assert.ok(
    existsSync(join(dataDirectory, 'app-data', 'local', 'git', 'inst-2')),
    'an empty directory was not restored',
  )
})

test('restoring touches only the roots the archive declares', async () => {
  const archive = join(workdir, 'scoped.zip')
  const { manifest, trailer } = await writeBackupArchive(archive, {
    ...(await sampleDatabase()),
    dataDirectory,
    roots: [{ name: 'app-data', policy: 'all' }],
  })
  // The database and the backups themselves live in the same data directory.
  mkdirSync(join(dataDirectory, 'pglite'), { recursive: true })
  writeFileSync(join(dataDirectory, 'pglite', 'PG_VERSION'), '15\n')

  await extractBackupFiles(archive, dataDirectory, { manifest, trailer })

  assert.ok(existsSync(join(dataDirectory, 'pglite', 'PG_VERSION')), 'the restore reached outside its roots')
  assert.ok(
    existsSync(join(dataDirectory, 'extensions', 'local.sample-ext', 'package.json')),
    'a root the archive did not declare was cleared anyway',
  )
})

test('an executable file comes back executable', async () => {
  // fflate's streaming reader does not hand back the mode the archive stores,
  // so without the trailer's own list this restores as 0644 and a script that
  // used to run does not. `agent-workspace` is carried whole exactly because
  // anything can be in it.
  const script = join(dataDirectory, 'app-data', 'local', 'design-kit', 'inst-1', 'run.sh')
  writeFileSync(script, '#!/bin/sh\necho hi\n')
  chmodSync(script, 0o755)
  const archive = join(workdir, 'executable.zip')
  const { manifest, trailer } = await writeBackupArchive(archive, {
    ...(await sampleDatabase()),
    dataDirectory,
    roots: ROOTS,
  })
  assert.ok(trailer.executables.includes('files/app-data/local/design-kit/inst-1/run.sh'))

  await extractBackupFiles(archive, dataDirectory, { manifest, trailer })

  assert.equal(statSync(script).mode & 0o111, 0o111, 'the executable bit was lost in the restore')
  const plain = join(dataDirectory, 'app-data', 'local', 'design-kit', 'inst-1', 'registry.json')
  assert.equal(statSync(plain).mode & 0o111, 0, 'a plain file came back executable')
})

test('the trailer counts what was carried', async () => {
  const archive = join(workdir, 'stats.zip')
  const { trailer } = await writeBackupArchive(archive, { ...(await sampleDatabase()), dataDirectory, roots: ROOTS })

  const appData = trailer.files['app-data']
  assert.equal(appData.files, 2, 'button.tsx and registry.json')
  assert.ok(appData.directories >= 4)
  assert.equal(
    appData.bytes,
    statSync(join(dataDirectory, 'app-data', 'local', 'design-kit', 'inst-1', 'components', 'button.tsx')).size +
      statSync(join(dataDirectory, 'app-data', 'local', 'design-kit', 'inst-1', 'registry.json')).size,
  )
  assert.equal(trailer.algorithm, 'sha256')
  assert.match(trailer.digest, /^[0-9a-f]{64}$/)
})

test('a root that does not exist is carried as nothing rather than failing', async () => {
  rmSync(join(dataDirectory, 'extensions'), { recursive: true, force: true })
  const archive = join(workdir, 'missing-root.zip')

  const { trailer } = await writeBackupArchive(archive, { ...(await sampleDatabase()), dataDirectory, roots: ROOTS })

  assert.deepEqual(trailer.files.extensions, { files: 0, directories: 0, bytes: 0 })
  const manifest = await readArchiveManifest(archive)
  assert.ok(manifest.fileRoots.includes('extensions'))
})

test('restoring an archive whose root is empty clears that root', async () => {
  rmSync(join(dataDirectory, 'extensions'), { recursive: true, force: true })
  const archive = join(workdir, 'empty-root.zip')
  const { manifest, trailer } = await writeBackupArchive(archive, {
    ...(await sampleDatabase()),
    dataDirectory,
    roots: ROOTS,
  })
  buildDataDirectory()

  await extractBackupFiles(archive, dataDirectory, { manifest, trailer })

  assert.deepEqual(readdirSync(join(dataDirectory, 'extensions')), [])
})

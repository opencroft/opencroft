// What `ensureBuilt` decides is FRESH, and what it serves when a rebuild
// fails. The staleness test may only require the bundles this extension can
// produce: the compiler writes nothing for a side with no entry, so demanding
// both bundles makes a one-sided extension permanently stale -- rebuilt on
// every consultation, forever. The same two-sided demand in the fallback would
// make "keep the existing bundle" unreachable for a one-sided extension,
// turning a failed rebuild that should serve the previous bundle into a throw.
//
// Real git checkouts and real builds rather than mocks, for the same reason as
// ensure-built-rebuild.test.ts: freshness is decided from what is actually on
// disk, so a fake would be testing the fake.

import assert from 'node:assert/strict'
import { execFile } from 'node:child_process'
import { promises as fs } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import test, { after } from 'node:test'
import { promisify } from 'node:util'

import { toastStore } from '@/lib/toast-store'
import { ensureExtensionBuilt } from './loader'

const run = promisify(execFile)

const root = await fs.mkdtemp(path.join(os.tmpdir(), 'ext-freshness-'))
const savedDataDir = process.env.OPENCROFT_DATA_DIR
process.env.OPENCROFT_DATA_DIR = root

after(async () => {
  if (savedDataDir === undefined) {
    delete process.env.OPENCROFT_DATA_DIR
  } else {
    process.env.OPENCROFT_DATA_DIR = savedDataDir
  }
  await fs.rm(root, { recursive: true, force: true })
})

// A committer identity for the scratch repos, kept out of any shared git config.
const GIT_ENV = {
  ...process.env,
  GIT_AUTHOR_NAME: 'test',
  GIT_AUTHOR_EMAIL: 'test@example.test',
  GIT_COMMITTER_NAME: 'test',
  GIT_COMMITTER_EMAIL: 'test@example.test',
}

let seq = 0

async function makeFixture(
  sides: { client?: boolean; server?: boolean },
  opts: { broken?: boolean } = {},
): Promise<{
  id: string
  dir: string
}> {
  seq += 1
  const id = `local.ext-${seq}`
  const dir = path.join(root, 'extensions', id)
  await fs.mkdir(dir, { recursive: true })
  if (sides.client) {
    await fs.mkdir(path.join(dir, 'src'), { recursive: true })
    // A broken source is a syntax error, so its build fails.
    const source = opts.broken ? 'export default {\n' : 'export default { hello: "world" }\n'
    await fs.writeFile(path.join(dir, 'src', 'client.tsx'), source)
  }
  if (sides.server) {
    await fs.mkdir(path.join(dir, 'server'), { recursive: true })
    await fs.writeFile(path.join(dir, 'server', 'index.ts'), 'export const actions = {}\n')
  }
  await fs.writeFile(path.join(dir, 'extension.json'), JSON.stringify({ id, name: id, version: '0.0.0' }))
  await fs.writeFile(path.join(dir, '.gitignore'), 'dist/\nnode_modules/\n')

  await run('git', ['init', '-q'], { cwd: dir })
  await run('git', ['add', '-A'], { cwd: dir })
  await run('git', ['-c', 'commit.gpgsign=false', 'commit', '-q', '-m', 'init'], { cwd: dir, env: GIT_ENV })

  return { id, dir }
}

// Dated an hour ahead rather than left at the moment of the write: the wall
// clock can step back between writing the sources and writing this, and a file
// written after them would then carry an earlier mtime and read as stale.
async function writeNewerThanSources(file: string, contents: string): Promise<void> {
  await fs.writeFile(file, contents)
  const ahead = new Date(Date.now() + 60 * 60 * 1000)
  await fs.utimes(file, ahead, ahead)
}

function captureToasts(): { events: string[]; stop: () => void } {
  const events: string[] = []
  const stop = toastStore.subscribe((data) => events.push(data))
  return { events, stop }
}

test('a client-only extension, once built, is fresh — it does not rebuild on every consultation', async () => {
  const { id, dir } = await makeFixture({ client: true })

  await ensureExtensionBuilt(id)
  await assert.rejects(fs.stat(path.join(dir, 'dist', 'server.js')), 'a client-only build produces no server bundle')

  // A sentinel the next consultation must leave alone: its mtime is newer than
  // any source, so a second ensure that still rebuilds can only be requiring
  // the server bundle that will never exist.
  const clientBundle = path.join(dir, 'dist', 'client.js')
  await writeNewerThanSources(clientBundle, 'SENTINEL')
  await ensureExtensionBuilt(id)
  assert.equal(
    await fs.readFile(clientBundle, 'utf-8'),
    'SENTINEL',
    'an up-to-date client-only extension must not be rebuilt just because it has no server bundle',
  )
})

test('a server-only extension, once built, is fresh — same rule, other side', async () => {
  const { id, dir } = await makeFixture({ server: true })

  await ensureExtensionBuilt(id)
  await assert.rejects(fs.stat(path.join(dir, 'dist', 'client.js')), 'a server-only build produces no client bundle')

  const serverBundle = path.join(dir, 'dist', 'server.js')
  await writeNewerThanSources(serverBundle, 'SENTINEL')
  await ensureExtensionBuilt(id)
  assert.equal(
    await fs.readFile(serverBundle, 'utf-8'),
    'SENTINEL',
    'an up-to-date server-only extension must not be rebuilt just because it has no client bundle',
  )
})

test('a failed client-only rebuild keeps serving the existing client bundle instead of throwing', async () => {
  const { id, dir } = await makeFixture({ client: true }, { broken: true })

  // An existing bundle, older than the sources so the rebuild is due.
  const clientBundle = path.join(dir, 'dist', 'client.js')
  await fs.mkdir(path.join(dir, 'dist'), { recursive: true })
  await fs.writeFile(clientBundle, 'OLD-CLIENT')
  const old = new Date('2020-01-01T00:00:00Z')
  await fs.utimes(clientBundle, old, old)

  const { events, stop } = captureToasts()
  try {
    await ensureExtensionBuilt(id)
  } finally {
    stop()
  }

  assert.equal(
    await fs.readFile(clientBundle, 'utf-8'),
    'OLD-CLIENT',
    'the previous bundle is what a failed rebuild serves — for a one-sided extension too',
  )
  assert.ok(
    events.some((event) => event.includes('build failed') && event.includes(id)),
    'the failure is still announced',
  )
})

test('a client bundle with no icon record is rebuilt even though it is newer than its sources', async () => {
  const { id, dir } = await makeFixture({ client: true })
  await ensureExtensionBuilt(id)
  const clientBundle = path.join(dir, 'dist', 'client.js')
  const icons = path.join(dir, 'dist', 'icons.json')
  assert.deepEqual(JSON.parse(await fs.readFile(icons, 'utf-8')), [], 'a build records its icons, none here')

  // A bundle built before icons were recorded: current, but without the record.
  await writeNewerThanSources(clientBundle, 'SENTINEL')
  await fs.rm(icons)
  await ensureExtensionBuilt(id)
  assert.notEqual(await fs.readFile(clientBundle, 'utf-8'), 'SENTINEL', 'the bundle is rebuilt')
  await fs.stat(icons)
})

test('a failed rebuild of a bundle with no icon record keeps serving that bundle', async () => {
  const { id, dir } = await makeFixture({ client: true }, { broken: true })
  const clientBundle = path.join(dir, 'dist', 'client.js')
  await fs.mkdir(path.join(dir, 'dist'), { recursive: true })
  await fs.writeFile(clientBundle, 'OLD-CLIENT')

  const { stop } = captureToasts()
  try {
    await ensureExtensionBuilt(id)
  } finally {
    stop()
  }
  assert.equal(await fs.readFile(clientBundle, 'utf-8'), 'OLD-CLIENT')
})

test('an extension with no buildable entry on either side is left alone', async () => {
  const { id, dir } = await makeFixture({})

  const { events, stop } = captureToasts()
  try {
    await ensureExtensionBuilt(id)
    await ensureExtensionBuilt(id)
  } finally {
    stop()
  }

  await assert.rejects(fs.stat(path.join(dir, 'dist')), 'nothing to build means nothing to write')
  assert.equal(events.length, 0, 'and nothing to announce')
})

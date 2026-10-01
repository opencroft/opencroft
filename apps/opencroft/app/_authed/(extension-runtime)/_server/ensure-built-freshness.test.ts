// What `ensureBuilt` decides is FRESH, and what it serves when it declines to
// rebuild. The staleness test may only require the bundles this extension can
// produce: the compiler writes nothing for a side with no entry, so demanding
// both bundles makes a one-sided extension permanently stale -- rebuilt on
// every consultation, forever. The same
// two-sided demand in the refusal fallback made "keep the existing bundle"
// unreachable for a one-sided extension, turning a refusal that should serve
// the previous bundle into a thrown "was not built".
//
// Real git checkouts and real builds rather than mocks, for the same reason as
// ensure-built-guard.test.ts: freshness is decided from what is actually on
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
  opts: { dirty?: boolean } = {},
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
    await fs.writeFile(path.join(dir, 'src', 'client.tsx'), 'export default { hello: "world" }\n')
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

  if (opts.dirty) {
    // An authored, uncommitted change in whichever side exists.
    const file = sides.client ? path.join(dir, 'src', 'client.tsx') : path.join(dir, 'server', 'index.ts')
    await fs.appendFile(file, '// edit in progress\n')
  }

  return { id, dir }
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
  await fs.writeFile(clientBundle, 'SENTINEL')
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
  await fs.writeFile(serverBundle, 'SENTINEL')
  await ensureExtensionBuilt(id)
  assert.equal(
    await fs.readFile(serverBundle, 'utf-8'),
    'SENTINEL',
    'an up-to-date server-only extension must not be rebuilt just because it has no client bundle',
  )
})

test('a refused client-only rebuild keeps serving the existing client bundle instead of throwing', async () => {
  const { id, dir } = await makeFixture({ client: true }, { dirty: true })

  // An existing bundle, older than the sources so the rebuild is due and the
  // guard is actually reached.
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
    'the previous bundle is what a refused rebuild serves — for a one-sided extension too',
  )
  assert.ok(
    events.some((event) => event.includes('was not rebuilt') && event.includes(id)),
    'the refusal is still announced',
  )
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

// The browser's manifest listing rebuilds stale client bundles before it reads
// their versions. Those versions go into immutably cached URLs, so a source
// edit has to change the version the browser is handed, or a browser that
// cached the old bundle never asks again. Real git checkouts and real builds,
// as in ensure-built-freshness.test.ts: freshness is decided from what is on
// disk.

import assert from 'node:assert/strict'
import { execFile, execFileSync } from 'node:child_process'
import { promises as fs } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import test, { after, beforeEach } from 'node:test'
import { promisify } from 'node:util'

import { toastStore } from '@/lib/toast-store'
import { listExtensionClientsImpl, listExtensionManifestsImpl } from './extension-action-impl'
import { clientBundleVersion } from './loader'

const run = promisify(execFile)

const hasGit = (() => {
  try {
    execFileSync('git', ['--version'])
    return true
  } catch {
    return false
  }
})()
const needsGit = { skip: hasGit ? false : 'git is missing; the fixtures are git checkouts' }

const root = await fs.mkdtemp(path.join(os.tmpdir(), 'client-bundles-built-'))
const savedDataDir = process.env.OPENCROFT_DATA_DIR

let seq = 0

// Each test gets its own data dir, so a listing in one never builds another's fixtures.
beforeEach(async () => {
  seq += 1
  const dataDir = path.join(root, `data-${seq}`)
  await fs.mkdir(dataDir, { recursive: true })
  process.env.OPENCROFT_DATA_DIR = dataDir
})

after(async () => {
  if (savedDataDir === undefined) {
    delete process.env.OPENCROFT_DATA_DIR
  } else {
    process.env.OPENCROFT_DATA_DIR = savedDataDir
  }
  await fs.rm(root, { recursive: true, force: true })
})

const GIT_ENV = {
  ...process.env,
  GIT_AUTHOR_NAME: 'test',
  GIT_AUTHOR_EMAIL: 'test@example.test',
  GIT_COMMITTER_NAME: 'test',
  GIT_COMMITTER_EMAIL: 'test@example.test',
}

async function commitAll(dir: string, message: string): Promise<void> {
  await run('git', ['add', '-A'], { cwd: dir })
  await run('git', ['-c', 'commit.gpgsign=false', 'commit', '-q', '-m', message], { cwd: dir, env: GIT_ENV })
}

/** A committed client-only extension `local.<name>` whose client entry is `source`. */
async function makeClientExtension(name: string, source: string): Promise<{ id: string; dir: string }> {
  const id = `local.${name}`
  const dir = path.join(process.env.OPENCROFT_DATA_DIR as string, 'extensions', id)
  await fs.mkdir(path.join(dir, 'src'), { recursive: true })
  await fs.writeFile(path.join(dir, 'src', 'client.tsx'), source)
  await fs.writeFile(path.join(dir, 'extension.json'), JSON.stringify({ id, name: id, version: '0.0.0' }))
  await fs.writeFile(path.join(dir, '.gitignore'), 'dist/\nnode_modules/\n')
  await run('git', ['init', '-q'], { cwd: dir })
  await commitAll(dir, 'init')
  return { id, dir }
}

/** Date the built bundle back, so a source written now is strictly newer than it. */
async function ageBundle(dir: string): Promise<void> {
  const old = new Date('2020-01-01T00:00:00Z')
  for (const name of ['client.js', 'client.css']) {
    await fs.utimes(path.join(dir, 'dist', name), old, old).catch(() => {})
  }
}

/** The client version a listing hands out for `id`. */
async function listedVersion(id: string, rebuildStaleClients: boolean): Promise<number | undefined> {
  const manifests = await listExtensionManifestsImpl({ rebuildStaleClients })
  return manifests.find((manifest) => manifest.id === id)?.clientVersion
}

async function edit(dir: string): Promise<void> {
  await fs.writeFile(path.join(dir, 'src', 'client.tsx'), 'export default { label: "after" }\n')
  await commitAll(dir, 'edit')
}

test('a client bundle whose sources changed is rebuilt and listed at its new version', needsGit, async () => {
  const { id, dir } = await makeClientExtension('edited', 'export default { label: "before" }\n')
  await listedVersion(id, true)
  await ageBundle(dir)
  const before = await clientBundleVersion(id)

  await edit(dir)
  const listed = await listedVersion(id, true)

  assert.notEqual(listed, before)
  assert.equal(listed, await clientBundleVersion(id))
  assert.match(await fs.readFile(path.join(dir, 'dist', 'client.js'), 'utf-8'), /after/)
})

test('an unchanged client bundle is left as built, so its listed version holds', needsGit, async () => {
  const { id, dir } = await makeClientExtension('unchanged', 'export default {}\n')
  await listedVersion(id, true)
  // Newer than every source, so only a rebuild that should not happen replaces
  // it. Dated an hour ahead rather than left at the moment of the write: the
  // wall clock can step back after the sources are written, and the sentinel
  // would then carry an earlier mtime than they do.
  const sentinel = path.join(dir, 'dist', 'client.js')
  await fs.writeFile(sentinel, 'SENTINEL')
  const ahead = new Date(Date.now() + 60 * 60 * 1000)
  await fs.utimes(sentinel, ahead, ahead)
  const before = await clientBundleVersion(id)

  assert.equal(await listedVersion(id, true), before)
  assert.equal(await fs.readFile(path.join(dir, 'dist', 'client.js'), 'utf-8'), 'SENTINEL')
})

test('a listing not asked to rebuild hands out the version as it is', needsGit, async () => {
  const { id, dir } = await makeClientExtension('not-asked', 'export default { label: "before" }\n')
  await listedVersion(id, true)
  await ageBundle(dir)
  const before = await clientBundleVersion(id)

  await edit(dir)

  assert.equal(await listedVersion(id, false), before)
  assert.match(await fs.readFile(path.join(dir, 'dist', 'client.js'), 'utf-8'), /before/)
})

test('a failing extension listed on every page load is announced once', needsGit, async () => {
  const { id, dir } = await makeClientExtension('failing', 'export default {}\n')
  await listedVersion(id, true)
  await ageBundle(dir)
  // A syntax error, so every rebuild of this source fails the same way.
  await fs.writeFile(path.join(dir, 'src', 'client.tsx'), 'export default {\n')
  await commitAll(dir, 'break')

  const events: string[] = []
  const stop = toastStore.subscribe((data) => events.push(data))
  try {
    await listedVersion(id, true)
    await listedVersion(id, true)
  } finally {
    stop()
  }

  assert.equal(events.filter((event) => event.includes('build failed') && event.includes(id)).length, 1)
})

// Every signed-in page asks for this listing, so it carries what importing a
// bundle takes and nothing else: a manifest's action descriptions and input
// schemas are for agents and the extension pages, which read the full manifest.
test('the browser listing names each client bundle with only what importing it takes', needsGit, async () => {
  const { id, dir } = await makeClientExtension('described', 'export default {}\n')
  await fs.writeFile(
    path.join(dir, 'extension.json'),
    JSON.stringify({
      id,
      name: id,
      version: '0.0.0',
      description: 'an extension with a long description',
      nodes: [
        {
          type: 'widget',
          name: 'Widget',
          actions: [{ id: 'run', label: 'Run', description: 'runs it', inputSchema: { type: 'object' } }],
        },
      ],
    }),
  )
  await commitAll(dir, 'describe')
  const serverOnly = 'local.server-only'
  const serverOnlyDir = path.join(process.env.OPENCROFT_DATA_DIR as string, 'extensions', serverOnly)
  await fs.mkdir(serverOnlyDir, { recursive: true })
  await fs.writeFile(
    path.join(serverOnlyDir, 'extension.json'),
    JSON.stringify({ id: serverOnly, name: serverOnly, version: '0.0.0' }),
  )

  const clients = await listExtensionClientsImpl()

  assert.deepEqual(
    clients.find((client) => client.id === id),
    { id, folder: id, clientVersion: await clientBundleVersion(id), clientIcons: [] },
  )
  assert.ok(await clientBundleVersion(id), 'the bundle was built, so the version above is a real one')
  assert.equal(
    clients.some((client) => client.id === serverOnly),
    false,
    'an extension without a client bundle is not listed',
  )
  assert.ok(
    (await listExtensionManifestsImpl()).some((manifest) => manifest.id === serverOnly),
    'while the full listing does have it, so its absence above is the filter',
  )
})

test('an extension that fails to build does not stop the others', needsGit, async () => {
  const broken = await makeClientExtension('broken', 'export default {\n')
  const { id, dir } = await makeClientExtension('healthy', 'export default { label: "before" }\n')
  await listedVersion(id, true)
  await ageBundle(dir)

  await edit(dir)
  const manifests = await listExtensionManifestsImpl({ rebuildStaleClients: true })

  assert.equal(manifests.find((manifest) => manifest.id === broken.id)?.clientVersion, 0, 'listed, with nothing built')
  assert.match(await fs.readFile(path.join(dir, 'dist', 'client.js'), 'utf-8'), /after/, `${id} was rebuilt`)
})

import assert from 'node:assert/strict'
import { promises as fs } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import test, { after } from 'node:test'

import { clientBundleVersion } from './loader'

// extDir reads the data dir at call time, so pointing it at a scratch dir keeps
// the test off the real extension tree.
const root = await fs.mkdtemp(path.join(os.tmpdir(), 'ext-version-'))
const savedDataDir = process.env.OPENCROFT_DATA_DIR
process.env.OPENCROFT_DATA_DIR = root

const EXTENSION_ID = 'local.sample'

after(async () => {
  if (savedDataDir === undefined) {
    delete process.env.OPENCROFT_DATA_DIR
  } else {
    process.env.OPENCROFT_DATA_DIR = savedDataDir
  }
  await fs.rm(root, { recursive: true, force: true })
})

async function writeBundle(name: string, contents: string, mtimeMs?: number): Promise<void> {
  const dist = path.join(root, 'extensions', EXTENSION_ID, 'dist')
  await fs.mkdir(dist, { recursive: true })
  const file = path.join(dist, name)
  await fs.writeFile(file, contents)
  if (mtimeMs !== undefined) {
    const when = new Date(mtimeMs)
    await fs.utimes(file, when, when)
  }
}

test('an unbuilt extension has no version, so its URL cannot be cached', async () => {
  // 0 is the signal the caller turns into a unique cache-busting value — an
  // extension with nothing built must never be served under a cacheable URL.
  assert.equal(await clientBundleVersion('local.never-built'), 0)
})

test('the version is stable while the built bundle is unchanged', async () => {
  await writeBundle('client.js', 'export default {}', 1_000_000)
  const first = await clientBundleVersion(EXTENSION_ID)
  const second = await clientBundleVersion(EXTENSION_ID)
  assert.equal(first, second)
  assert.ok(first > 0)
})

test('rebuilding the bundle changes the version', async () => {
  await writeBundle('client.js', 'export default {}', 1_000_000)
  const before = await clientBundleVersion(EXTENSION_ID)
  await writeBundle('client.js', 'export default { rebuilt: true }', 2_000_000)
  const after = await clientBundleVersion(EXTENSION_ID)
  assert.notEqual(before, after)
})

test('a stylesheet-only rebuild also changes the version', async () => {
  // The two artifacts are versioned together, so a build that only moved the
  // CSS must still produce a new URL — otherwise the stale sheet stays cached.
  await writeBundle('client.js', 'export default {}', 1_000_000)
  await writeBundle('client.css', '.a{}', 1_000_000)
  const before = await clientBundleVersion(EXTENSION_ID)
  await writeBundle('client.css', '.a{color:red}', 3_000_000)
  const after = await clientBundleVersion(EXTENSION_ID)
  assert.notEqual(before, after)
  assert.equal(after, 3_000_000)
})

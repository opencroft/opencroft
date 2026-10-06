// Exercises the real activation pipeline (build + eval + load lifecycle)
// against a scratch fixture extension -- not mocked, since the defect this
// guards (two concurrent callers each independently reactivating) only
// exists in the real interaction between concurrent callers and the module
// cache. Reproduced before this fix: two requests 5ms apart
// after a single, solitary compile were enough to trigger two separate
// `load()` calls.
import assert from 'node:assert/strict'
import { promises as fs } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import test, { after } from 'node:test'

import { flushCache, getExtensionModule } from './loader'

const root = await fs.mkdtemp(path.join(os.tmpdir(), 'ext-activation-race-'))
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

let seq = 0

// `load()` appends a line to `logFile` (an absolute path baked into the
// source at fixture-creation time) and then artificially delays, so two
// concurrent activations have a wide window to both start before either
// finishes -- large enough that a real race, not just a lucky scheduling
// order, is what a passing test proves.
async function makeFixture(): Promise<{
  id: string
  manifest: { id: string; name: string; version: string }
  logFile: string
}> {
  seq += 1
  const id = `local.activation-sample-${seq}`
  const dir = path.join(root, 'extensions', id)
  const logFile = path.join(root, `${id}-load-log.txt`)
  await fs.mkdir(path.join(dir, 'src'), { recursive: true })
  await fs.mkdir(path.join(dir, 'server'), { recursive: true })
  await fs.writeFile(path.join(dir, 'src', 'client.tsx'), 'export default {}\n')
  // The sleep is inside the fixture extension's own load(), making the code
  // under test slow on purpose so an overlapping activation has something to
  // overlap. It is not this test waiting for anything: the callers below race
  // because they are issued in one tick, and the assertions count load() calls
  // rather than timing them. Examined during a sweep for tests bounded by a
  // guess; this is not one.
  await fs.writeFile(
    path.join(dir, 'server', 'index.ts'),
    `import { promises as fs } from 'node:fs'
export async function load() {
  await fs.appendFile(${JSON.stringify(logFile)}, 'load\\n')
  await new Promise((resolve) => setTimeout(resolve, 200))
}
export const actions = {}
`,
  )
  const manifest = { id, name: id, version: '0.0.0' }
  await fs.writeFile(path.join(dir, 'extension.json'), JSON.stringify(manifest))
  // Dated an hour back, directories included because the freshness walk reads
  // their mtimes too. A cached module is fresh while its sources are no newer
  // than its activation time, and the wall clock can step back during the
  // build, which would date the activation before sources written just now.
  const old = new Date(Date.now() - 60 * 60 * 1000)
  for (const entry of ['src/client.tsx', 'src', 'server/index.ts', 'server', 'extension.json']) {
    await fs.utimes(path.join(dir, entry), old, old)
  }
  return { id, manifest, logFile }
}

async function loadCount(logFile: string): Promise<number> {
  const text = await fs.readFile(logFile, 'utf-8').catch(() => '')
  return text.split('\n').filter(Boolean).length
}

test('two concurrent getExtensionModule calls after a fresh compile share one activation', async () => {
  const { id, logFile } = await makeFixture()

  const [a, b] = await Promise.all([getExtensionModule(id), getExtensionModule(id)])

  assert.equal(a, b, 'both callers must be handed the exact same module instance')
  assert.equal(await loadCount(logFile), 1, 'load() must run exactly once, not once per racing caller')
})

test('many concurrent getExtensionModule calls after a fresh compile still share one activation', async () => {
  const { id, logFile } = await makeFixture()

  const results = await Promise.all(Array.from({ length: 10 }, () => getExtensionModule(id)))

  for (const result of results) {
    assert.equal(result, results[0], 'every caller must be handed the same module instance')
  }
  assert.equal(await loadCount(logFile), 1, 'load() must run exactly once across 10 racing callers')
})

test('a call after everything has settled reuses the cached module, no reactivation', async () => {
  const { id, logFile } = await makeFixture()

  const first = await getExtensionModule(id)
  const second = await getExtensionModule(id)

  assert.equal(first, second)
  assert.equal(await loadCount(logFile), 1, 'a settled, non-stale call must not reactivate')
})

test('flushCache followed by concurrent callers still shares one reactivation', async () => {
  const { id, logFile } = await makeFixture()
  await getExtensionModule(id)
  assert.equal(await loadCount(logFile), 1)

  flushCache(id)
  const [a, b, c] = await Promise.all([getExtensionModule(id), getExtensionModule(id), getExtensionModule(id)])

  assert.equal(a, b)
  assert.equal(b, c)
  assert.equal(await loadCount(logFile), 2, 'the post-flush reactivation must be shared, not one per caller')
})

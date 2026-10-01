// Exercises the real build pipeline (esbuild) against a scratch fixture with a
// dynamic import — not mocked, since the defects this guards (a reader
// resolving an entry to a chunk that isn't published yet, disk growing
// unbounded from orphaned chunks) only exist in the real interaction between
// esbuild's `outdir`/`splitting` output and the filesystem. See build-race.ts
// for the equivalent single-file coverage this extends to a set of files.
import assert from 'node:assert/strict'
import { promises as fs } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import test, { after } from 'node:test'

import { buildExtension } from './compiler'

const root = await fs.mkdtemp(path.join(os.tmpdir(), 'ext-code-splitting-'))
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

// Large enough that esbuild's own multi-file write genuinely spans multiple
// event loop turns — the same reasoning as build-race.test.ts's 4MB body. Too
// small and a partial-read/race test passes by accident, not by the fix.
function bigModuleSource(marker: string): string {
  return `export default ${JSON.stringify(`${marker}${'z'.repeat(2_000_000)}`)}\n`
}

async function makeFixture(marker: string): Promise<{
  id: string
  manifest: { id: string; name: string; version: string }
  dir: string
}> {
  seq += 1
  const id = `local.split-${seq}`
  const dir = path.join(root, 'extensions', id)
  await fs.mkdir(path.join(dir, 'src'), { recursive: true })
  await fs.mkdir(path.join(dir, 'server'), { recursive: true })
  await fs.writeFile(
    path.join(dir, 'src', 'client.tsx'),
    "export default async function load() {\n  const mod = await import('./big-module')\n  return mod.default\n}\n",
  )
  await fs.writeFile(path.join(dir, 'src', 'big-module.ts'), bigModuleSource(marker))
  await fs.writeFile(path.join(dir, 'server', 'index.ts'), 'export const actions = {}\n')
  const manifest = { id, name: id, version: '0.0.0' }
  await fs.writeFile(path.join(dir, 'extension.json'), JSON.stringify(manifest))
  return { id, manifest, dir }
}

function distDir(dir: string): string {
  return path.join(dir, 'dist')
}

test('a dynamic import produces a separate chunk, not inlined into client.js', async () => {
  const { id, manifest, dir } = await makeFixture('marker-')
  const result = await buildExtension(id, manifest)
  assert.ok(result.success, JSON.stringify(result.errors))

  const clientJs = await fs.readFile(path.join(distDir(dir), 'client.js'), 'utf-8')
  assert.ok(!clientJs.includes('marker-'), 'the dynamically-imported module must not be inlined into the entry')

  const entries = await fs.readdir(distDir(dir))
  const chunks = entries.filter((f) => f.startsWith('chunk-') && f.endsWith('.js'))
  assert.equal(chunks.length, 1, 'exactly one chunk should be emitted for the one dynamic import')
  const chunkContent = await fs.readFile(path.join(distDir(dir), chunks[0]), 'utf-8')
  assert.ok(chunkContent.includes('marker-'), 'the chunk must contain the dynamically-imported module')
})

test('a concurrent reader of client.js can always resolve every chunk it imports', async () => {
  const { id, manifest, dir } = await makeFixture('race-')
  const dist = distDir(dir)

  // Published once first, so there is an entry on disk to be a reader OF. On a
  // fresh fixture `client.js` does not exist until the build's last act, so a
  // poller racing that build reads nothing at all on every pass and the
  // chunk-resolution assertion never runs while anything is concurrent -- the
  // guard below would then be counting a single read of a settled bundle.
  // The invariant is about a REBUILD: an entry already being served while its
  // replacement stages.
  const published = await buildExtension(id, manifest)
  assert.ok(published.success, JSON.stringify(published.errors))
  await fs.writeFile(path.join(dir, 'src', 'big-module.ts'), bigModuleSource('rebuild-'))

  let sawStaging = false
  let checks = 0
  const inspect = async () => {
    const entries = await fs.readdir(dist).catch(() => [] as string[])
    if (entries.some((f) => f.includes('.building-'))) {
      sawStaging = true
    }
    const code = await fs.readFile(path.join(dist, 'client.js'), 'utf-8').catch(() => null)
    if (code === null) {
      return
    }
    checks += 1
    const imports = [...code.matchAll(/from *"(\.\/chunk-[^"]+)"/g)].map((m) => m[1])
    for (const spec of imports) {
      const chunkPath = path.join(dist, path.basename(spec))
      const exists = await fs.readFile(chunkPath, 'utf-8').catch(() => null)
      assert.ok(exists !== null, `client.js references ${spec}, which does not exist on disk yet`)
    }
  }

  // Bounded by the build, not by a count of iterations: a fixed count is a
  // guess about which of the two finishes first, and both guards below fail
  // when it loses -- too few iterations and the poller stops before the build
  // stages anything, too many and it spins after everything is published.
  let building = true
  const poll = (async () => {
    while (building) {
      await inspect()
    }
  })()

  const result = await buildExtension(id, manifest)
  building = false
  await poll

  assert.ok(result.success, JSON.stringify(result.errors))
  assert.ok(checks > 0, 'the poller must have actually read client.js at least once for this test to mean anything')
  assert.ok(sawStaging, 'the poller must have observed the build in progress (staging dir present)')
  const leftovers = (await fs.readdir(dist)).filter((f) => f.includes('.building-'))
  assert.deepEqual(leftovers, [], 'no staging directory may remain after a successful publish')
})

test('a rebuild that changes only the dynamically-imported module still changes the published entry', async () => {
  const { id, manifest, dir } = await makeFixture('before-')
  const first = await buildExtension(id, manifest)
  assert.ok(first.success, JSON.stringify(first.errors))
  const dist = distDir(dir)
  const firstEntry = await fs.readFile(path.join(dist, 'client.js'), 'utf-8')
  const firstStat = await fs.stat(path.join(dist, 'client.js'))

  await new Promise((resolve) => setTimeout(resolve, 10))
  await fs.writeFile(path.join(dir, 'src', 'big-module.ts'), bigModuleSource('after-'))
  const second = await buildExtension(id, manifest)
  assert.ok(second.success, JSON.stringify(second.errors))

  const secondEntry = await fs.readFile(path.join(dist, 'client.js'), 'utf-8')
  const secondStat = await fs.stat(path.join(dist, 'client.js'))
  assert.notEqual(secondEntry, firstEntry, "a rebuilt chunk's new content hash changes the entry's import specifier")
  assert.ok(
    secondStat.mtimeMs > firstStat.mtimeMs,
    'the entry mtime must move on a chunk-only change too, so clientBundleVersion picks it up',
  )
})

test('a chunk from moments ago survives the next build, even if nothing references it anymore', async () => {
  const { id, manifest, dir } = await makeFixture('gen1-')
  const first = await buildExtension(id, manifest)
  assert.ok(first.success, JSON.stringify(first.errors))
  const dist = distDir(dir)
  const firstChunks = (await fs.readdir(dist)).filter((f) => f.startsWith('chunk-') && f.endsWith('.js'))
  assert.equal(firstChunks.length, 1)

  await fs.writeFile(path.join(dir, 'src', 'big-module.ts'), bigModuleSource('gen2-'))
  const second = await buildExtension(id, manifest)
  assert.ok(second.success, JSON.stringify(second.errors))

  const afterEntries = await fs.readdir(dist)
  assert.ok(
    afterEntries.includes(firstChunks[0]),
    'a tab holding the previous entry may not have taken the code path that fetches this chunk yet',
  )
})

test('a chunk untouched for over the retention window is pruned on the next build', async () => {
  const { id, manifest, dir } = await makeFixture('gen1-')
  const first = await buildExtension(id, manifest)
  assert.ok(first.success, JSON.stringify(first.errors))
  const dist = distDir(dir)
  const firstChunks = (await fs.readdir(dist)).filter((f) => f.startsWith('chunk-') && f.endsWith('.js'))
  assert.equal(firstChunks.length, 1)
  const staleChunk = path.join(dist, firstChunks[0])
  const twoHoursAgo = new Date(Date.now() - 2 * 60 * 60 * 1000)
  await fs.utimes(staleChunk, twoHoursAgo, twoHoursAgo)

  await fs.writeFile(path.join(dir, 'src', 'big-module.ts'), bigModuleSource('gen2-'))
  const second = await buildExtension(id, manifest)
  assert.ok(second.success, JSON.stringify(second.errors))

  const afterEntries = await fs.readdir(dist)
  assert.ok(!afterEntries.includes(firstChunks[0]), 'a chunk untouched for over an hour must eventually be pruned')
})

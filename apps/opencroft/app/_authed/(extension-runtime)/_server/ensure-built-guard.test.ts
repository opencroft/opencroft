// The mtime-triggered rebuild in `ensureBuilt` must refuse to publish a
// registered checkout that is dirty or off its default branch -- the same
// refusal `compile_extension` already applies on the manual door. Without it,
// a plain edit / `git checkout` / `git pull` into the checkout deploys itself
// to the running instance on the next load, with nothing said.
//
// Exercised against a real git checkout in a scratch directory rather than a
// mock: the refusal reads git state straight from the directory, so a fake
// would be testing the fake. The refusal path returns before `buildExtension`,
// so the two refusal cases need only a fake `dist/` -- no real build -- while
// the clean-checkout control does drive the real pipeline, to prove the guard
// does not block a legitimate rebuild.

import assert from 'node:assert/strict'
import { execFile } from 'node:child_process'
import { promises as fs } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import test, { after } from 'node:test'
import { promisify } from 'node:util'

const run = promisify(execFile)

const root = await fs.mkdtemp(path.join(os.tmpdir(), 'ext-ensurebuilt-'))
process.env.OPENCROFT_LOCAL_EXTENSIONS = root

const { ensureExtensionBuilt } = await import('./loader')
const { toastStore } = await import('@/lib/toast-store')

after(async () => {
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

async function makeFixture(opts: { git: boolean; dirty: boolean; bundle: boolean }): Promise<{
  id: string
  distServer: string
}> {
  seq += 1
  const slug = `ext-${seq}`
  const dir = path.join(root, slug)
  await fs.mkdir(path.join(dir, 'src'), { recursive: true })
  await fs.mkdir(path.join(dir, 'server'), { recursive: true })
  await fs.writeFile(path.join(dir, 'src', 'client.tsx'), 'export default { hello: "world" }\n')
  await fs.writeFile(path.join(dir, 'server', 'index.ts'), 'export const actions = {}\n')
  await fs.writeFile(
    path.join(dir, 'extension.json'),
    JSON.stringify({ id: `local/${slug}`, name: slug, version: '0.0.0' }),
  )
  // dist and node_modules are generated; real extension repos ignore them, which
  // is what keeps a built checkout reading "clean". The fixture matches that so
  // the fake bundle below does not itself register as an authored change.
  await fs.writeFile(path.join(dir, '.gitignore'), 'dist/\nnode_modules/\n')

  if (opts.git) {
    await run('git', ['init', '-q'], { cwd: dir })
    await run('git', ['add', '-A'], { cwd: dir })
    await run('git', ['commit', '-q', '-m', 'init'], { cwd: dir, env: GIT_ENV })
  }

  const distServer = path.join(dir, 'dist', 'server.js')
  if (opts.bundle) {
    await fs.mkdir(path.join(dir, 'dist'), { recursive: true })
    await fs.writeFile(distServer, 'OLD-SERVER')
    await fs.writeFile(path.join(dir, 'dist', 'client.js'), 'OLD-CLIENT')
    // Older than any source, so the mtime check decides a rebuild is due and the
    // guard is actually reached rather than skipped as up to date.
    const old = new Date('2020-01-01T00:00:00Z')
    await fs.utimes(distServer, old, old)
    await fs.utimes(path.join(dir, 'dist', 'client.js'), old, old)
  }

  if (opts.dirty) {
    // An authored, uncommitted change — the state the manual path already
    // refuses. Appended after the commit so it stays uncommitted.
    await fs.appendFile(path.join(dir, 'src', 'client.tsx'), '// edit in progress\n')
  }

  return { id: `local/${slug}`, distServer }
}

function captureToasts(): { events: string[]; stop: () => void } {
  const events: string[] = []
  const stop = toastStore.subscribe((data) => events.push(data))
  return { events, stop }
}

test('a dirty registered checkout is not auto-published, and the existing bundle is kept', async () => {
  const { id, distServer } = await makeFixture({ git: true, dirty: true, bundle: true })
  const before = await fs.readFile(distServer, 'utf-8')

  const { events, stop } = captureToasts()
  try {
    await ensureExtensionBuilt(id)
  } finally {
    stop()
  }

  const after = await fs.readFile(distServer, 'utf-8')
  assert.equal(after, before, 'the running bundle must be left exactly as it was — no rebuild from a dirty tree')
  assert.equal(after, 'OLD-SERVER', 'and specifically the previous bundle, not a fresh build')
  assert.ok(
    events.some((event) => event.includes('was not rebuilt') && event.includes(id)),
    'the refusal must be announced, not silent',
  )
})

test('a dirty checkout with no existing bundle fails loudly rather than publishing itself', async () => {
  const { id } = await makeFixture({ git: true, dirty: true, bundle: false })

  const { events, stop } = captureToasts()
  try {
    await assert.rejects(
      () => ensureExtensionBuilt(id),
      /was not built/,
      'with nothing to fall back on it must refuse, not build the dirty tree',
    )
  } finally {
    stop()
  }
  assert.ok(
    events.some((event) => event.includes('was not rebuilt')),
    'the refusal is announced even when it also throws',
  )
})

test('a clean checkout on its default branch still builds', async () => {
  const { id, distServer } = await makeFixture({ git: true, dirty: false, bundle: false })

  const { events, stop } = captureToasts()
  try {
    await ensureExtensionBuilt(id)
  } finally {
    stop()
  }

  const built = await fs.readFile(distServer, 'utf-8')
  assert.ok(built.length > 0 && built !== 'OLD-SERVER', 'a clean checkout must build normally')
  assert.ok(!events.some((event) => event.includes('was not rebuilt')), 'a legitimate build raises no refusal')

  // The build records the commit it came from, so a later reader can tell what
  // is running apart from what the checkout is on.
  const provenance = JSON.parse(await fs.readFile(path.join(path.dirname(distServer), 'built.json'), 'utf-8'))
  const { stdout: head } = await run('git', ['rev-parse', 'HEAD'], { cwd: path.dirname(path.dirname(distServer)) })
  assert.equal(provenance.commit, head.trim(), 'the built bundle records the exact commit it was produced from')
  assert.equal(provenance.dirty, false, 'and that it was built from a clean tree')
})

test("a concurrent or crashed build's staging directory neither refuses nor wedges the rebuild", async () => {
  const { id, distServer } = await makeFixture({ git: true, dirty: false, bundle: false })
  const dir = path.dirname(path.dirname(distServer))

  // What an overlapping consultation sees mid-build, and what a killed build
  // leaves behind for every consultation after it: the compiler's own staging
  // directory beside dist/. Neither is authored work, so neither may read as
  // an uncommitted change.
  const stale = path.join(dir, 'dist.building-4-2')
  const fresh = path.join(dir, 'dist.building-5-3')
  await fs.mkdir(stale)
  await fs.writeFile(path.join(stale, 'client.js'), 'half-written')
  const old = new Date('2020-01-01T00:00:00Z')
  await fs.utimes(stale, old, old)
  await fs.mkdir(fresh)

  const { events, stop } = captureToasts()
  try {
    await ensureExtensionBuilt(id)
  } finally {
    stop()
  }

  assert.ok((await fs.readFile(distServer, 'utf-8')).length > 0, 'the rebuild goes ahead')
  assert.ok(!events.some((event) => event.includes('was not rebuilt')), 'machinery output raises no refusal')
  await assert.rejects(fs.stat(stale), 'a leftover from a dead attempt is swept, not left to accumulate')
  // An attempt young enough to still be running is left alone.
  await fs.stat(fresh)
})

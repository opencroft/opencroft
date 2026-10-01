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
import test, { after, mock } from 'node:test'
import { promisify } from 'node:util'

import { toastStore } from '@/lib/toast-store'
import { ensureExtensionBuilt } from './loader'

const run = promisify(execFile)

const root = await fs.mkdtemp(path.join(os.tmpdir(), 'ext-ensurebuilt-'))
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

async function makeFixture(opts: { git: boolean; dirty: boolean; bundle: boolean }): Promise<{
  id: string
  distServer: string
}> {
  seq += 1
  const id = `local.ext-${seq}`
  const dir = path.join(root, 'extensions', id)
  await fs.mkdir(path.join(dir, 'src'), { recursive: true })
  await fs.mkdir(path.join(dir, 'server'), { recursive: true })
  await fs.writeFile(path.join(dir, 'src', 'client.tsx'), 'export default { hello: "world" }\n')
  await fs.writeFile(path.join(dir, 'server', 'index.ts'), 'export const actions = {}\n')
  await fs.writeFile(path.join(dir, 'extension.json'), JSON.stringify({ id, name: id, version: '0.0.0' }))
  // dist and node_modules are generated; real extension repos ignore them, which
  // is what keeps a built checkout reading "clean". The fixture matches that so
  // the fake bundle below does not itself register as an authored change.
  await fs.writeFile(path.join(dir, '.gitignore'), 'dist/\nnode_modules/\n')

  if (opts.git) {
    await run('git', ['init', '-q'], { cwd: dir })
    await run('git', ['add', '-A'], { cwd: dir })
    await run('git', ['-c', 'commit.gpgsign=false', 'commit', '-q', '-m', 'init'], { cwd: dir, env: GIT_ENV })
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

  return { id, distServer }
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
  // directory, inside dist/. Neither is authored work, so neither may read as
  // an uncommitted change.
  const dist = path.join(dir, 'dist')
  const stale = path.join(dist, '.building-4-2')
  const fresh = path.join(dist, '.building-5-3')
  await fs.mkdir(stale, { recursive: true })
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

// Every page load consults every extension, so an outcome that cannot change
// until its inputs do must not be attempted, nor announced to everyone, again.

async function commitAll(dir: string): Promise<void> {
  await run('git', ['add', '-A'], { cwd: dir })
  await run('git', ['-c', 'commit.gpgsign=false', 'commit', '-q', '-m', 'edit'], { cwd: dir, env: GIT_ENV })
}

async function toastsDuring(body: () => Promise<unknown>): Promise<string[]> {
  const { events, stop } = captureToasts()
  try {
    await body()
  } finally {
    stop()
  }
  return events
}

test('a refusal is announced once while nothing it read has changed', async () => {
  const { id } = await makeFixture({ git: true, dirty: true, bundle: true })

  const events = await toastsDuring(async () => {
    await ensureExtensionBuilt(id)
    await ensureExtensionBuilt(id)
    await ensureExtensionBuilt(id)
  })

  assert.equal(events.filter((event) => event.includes('was not rebuilt') && event.includes(id)).length, 1)
})

test('a refused checkout with no bundle keeps failing, with the same reason, without announcing again', async () => {
  const { id } = await makeFixture({ git: true, dirty: true, bundle: false })

  const events = await toastsDuring(async () => {
    await assert.rejects(() => ensureExtensionBuilt(id), /was not built/)
    await assert.rejects(() => ensureExtensionBuilt(id), /was not built/)
  })

  assert.equal(events.filter((event) => event.includes('was not rebuilt')).length, 1)
})

test('committing the change lifts a refusal at the next check, though no source file changed', async () => {
  const { id, distServer } = await makeFixture({ git: true, dirty: true, bundle: true })
  await ensureExtensionBuilt(id)
  assert.equal(await fs.readFile(distServer, 'utf-8'), 'OLD-SERVER', 'refused while dirty')

  await commitAll(path.dirname(path.dirname(distServer)))
  await ensureExtensionBuilt(id)

  assert.notEqual(await fs.readFile(distServer, 'utf-8'), 'OLD-SERVER', 'built once committed')
})

test('removing an untracked file lifts a refusal at the next check', async () => {
  const { id, distServer } = await makeFixture({ git: true, dirty: false, bundle: true })
  const dir = path.dirname(path.dirname(distServer))
  await fs.mkdir(path.join(dir, 'notes'))
  await fs.writeFile(path.join(dir, 'notes', 'scratch.txt'), 'untracked')
  await ensureExtensionBuilt(id)
  assert.equal(await fs.readFile(distServer, 'utf-8'), 'OLD-SERVER', 'refused while an untracked file is present')

  await fs.rm(path.join(dir, 'notes', 'scratch.txt'))
  await ensureExtensionBuilt(id)

  assert.notEqual(await fs.readFile(distServer, 'utf-8'), 'OLD-SERVER', 'built once the tree is clean')
})

test('a failed build is attempted and announced once until its sources change', async () => {
  const { id, distServer } = await makeFixture({ git: true, dirty: false, bundle: true })
  const dir = path.dirname(path.dirname(distServer))
  const distClient = path.join(dir, 'dist', 'client.js')
  await fs.writeFile(path.join(dir, 'src', 'client.tsx'), 'export default {\n')
  await commitAll(dir)

  const failures = await toastsDuring(async () => {
    await ensureExtensionBuilt(id)
    await ensureExtensionBuilt(id)
  })
  assert.equal(failures.filter((event) => event.includes('build failed') && event.includes(id)).length, 1)
  assert.equal(await fs.readFile(distClient, 'utf-8'), 'OLD-CLIENT', 'the previous client bundle is still served')

  await fs.writeFile(path.join(dir, 'src', 'client.tsx'), 'export default { fixed: true }\n')
  await commitAll(dir)
  await ensureExtensionBuilt(id)

  assert.match(await fs.readFile(distClient, 'utf-8'), /fixed/, 'the fixed sources are built')
})

test('a failed dependency install is attempted again after the retry interval, with nothing changed', async (t) => {
  const hasNpm = await run('npm', ['--version']).then(
    () => true,
    () => false,
  )
  if (!hasNpm) {
    t.skip('npm is not installed, and the build installs dependencies with it')
    return
  }
  const { id, distServer } = await makeFixture({ git: true, dirty: false, bundle: true })
  const dir = path.dirname(path.dirname(distServer))
  // A local dependency tarball outside the checkout, so providing it later
  // changes nothing the checkout or its sources are judged by. npm fails on the
  // missing file and installs the present one without the network.
  const dependency = path.join(root, `dependency-${seq}.tgz`)
  await fs.writeFile(
    path.join(dir, 'package.json'),
    JSON.stringify({ name: id, version: '0.0.0', dependencies: { 'local-dependency': `file:${dependency}` } }),
  )
  await commitAll(dir)

  mock.timers.enable({ apis: ['Date'], now: Date.now() })
  try {
    const failures = await toastsDuring(async () => {
      await ensureExtensionBuilt(id)
      await ensureExtensionBuilt(id)
    })
    assert.equal(failures.filter((event) => event.includes('build failed') && event.includes(id)).length, 1)
    assert.equal(await fs.readFile(distServer, 'utf-8'), 'OLD-SERVER')

    const packageDir = path.join(root, `dependency-${seq}`)
    await fs.mkdir(packageDir)
    await fs.writeFile(
      path.join(packageDir, 'package.json'),
      JSON.stringify({ name: 'local-dependency', version: '1.0.0' }),
    )
    await run('npm', ['pack', packageDir, '--pack-destination', root], { cwd: root })
    await fs.rename(path.join(root, 'local-dependency-1.0.0.tgz'), dependency)
    await ensureExtensionBuilt(id)
    assert.equal(await fs.readFile(distServer, 'utf-8'), 'OLD-SERVER', 'not attempted again within the interval')

    mock.timers.tick(5 * 60 * 1000 + 1)
    await ensureExtensionBuilt(id)
  } finally {
    mock.timers.reset()
  }

  assert.notEqual(await fs.readFile(distServer, 'utf-8'), 'OLD-SERVER', 'attempted again, and built')
})

test('a refusal in a linked worktree is announced once too', async () => {
  seq += 1
  const main = path.join(root, `main-${seq}`)
  const id = `local.ext-${seq}`
  const dir = path.join(root, 'extensions', id)
  await fs.mkdir(path.join(main, 'src'), { recursive: true })
  await fs.writeFile(path.join(main, 'src', 'client.tsx'), 'export default {}\n')
  await fs.writeFile(path.join(main, 'extension.json'), JSON.stringify({ id, name: id, version: '0.0.0' }))
  await fs.writeFile(path.join(main, '.gitignore'), 'dist/\nnode_modules/\n')
  await run('git', ['init', '-q'], { cwd: main })
  await commitAll(main)
  await run('git', ['worktree', 'add', '-q', dir], { cwd: main })
  await fs.mkdir(path.join(dir, 'dist'))
  await fs.writeFile(path.join(dir, 'dist', 'client.js'), 'OLD-CLIENT')
  const old = new Date('2020-01-01T00:00:00Z')
  await fs.utimes(path.join(dir, 'dist', 'client.js'), old, old)
  await fs.appendFile(path.join(dir, 'src', 'client.tsx'), '// edit in progress\n')

  const events = await toastsDuring(async () => {
    await ensureExtensionBuilt(id)
    await ensureExtensionBuilt(id)
  })

  assert.equal(events.filter((event) => event.includes('was not rebuilt') && event.includes(id)).length, 1)
})

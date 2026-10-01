// Once the auto-rebuild refuses a dirty or off-branch checkout, the checkout's
// HEAD stops being a fair proxy for what the instance runs. The record read by
// `get_extension` therefore carries two extra facts: the commit the running
// bundle was actually built from, and the refusal that is holding the two
// apart. These assert that read against a real git checkout.

import '@opencroft/db/test-env'

import assert from 'node:assert/strict'
import { execFile } from 'node:child_process'
import { promises as fs } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import test, { after } from 'node:test'
import { promisify } from 'node:util'

import { extensionsRoot } from '@/app/_authed/(extension-runtime)/_server/paths'
import { getLocalExtensionImpl } from './local-extensions-actions-impl'

const run = promisify(execFile)

const scratch = await fs.mkdtemp(path.join(os.tmpdir(), 'ext-provenance-'))
const savedDataDir = process.env.OPENCROFT_DATA_DIR
process.env.OPENCROFT_DATA_DIR = scratch

after(async () => {
  if (savedDataDir === undefined) {
    delete process.env.OPENCROFT_DATA_DIR
  } else {
    process.env.OPENCROFT_DATA_DIR = savedDataDir
  }
  await fs.rm(scratch, { recursive: true, force: true })
})

const GIT_ENV = {
  ...process.env,
  GIT_AUTHOR_NAME: 'test',
  GIT_AUTHOR_EMAIL: 'test@example.test',
  GIT_COMMITTER_NAME: 'test',
  GIT_COMMITTER_EMAIL: 'test@example.test',
}

let seq = 0

// A committed extension checkout with a bundle that records `builtFrom` as the
// commit it was built from — i.e. the state after a build at that commit.
async function builtFixture(
  built: { dirty: boolean; dirtyPaths?: string[] } = { dirty: false },
): Promise<{ folder: string; dir: string; builtCommit: string }> {
  seq += 1
  const folder = `local.prov-${seq}`
  const dir = path.join(extensionsRoot(), folder)
  await fs.mkdir(path.join(dir, 'src'), { recursive: true })
  await fs.writeFile(path.join(dir, 'src', 'client.tsx'), 'export default { hello: "world" }\n')
  await fs.writeFile(path.join(dir, 'extension.json'), JSON.stringify({ name: folder, version: '0.0.0' }))
  await fs.writeFile(path.join(dir, '.gitignore'), 'dist/\nnode_modules/\n')
  await run('git', ['init', '-q'], { cwd: dir })
  await run('git', ['add', '-A'], { cwd: dir })
  await run('git', ['-c', 'commit.gpgsign=false', 'commit', '-q', '-m', 'init'], { cwd: dir, env: GIT_ENV })
  const { stdout } = await run('git', ['rev-parse', 'HEAD'], { cwd: dir })
  const builtCommit = stdout.trim()
  // The bundle and its provenance, as a successful build would have left them.
  // dist is gitignored, so none of this makes the checkout read dirty.
  await fs.mkdir(path.join(dir, 'dist'), { recursive: true })
  await fs.writeFile(path.join(dir, 'dist', 'server.js'), 'BUNDLE')
  await fs.writeFile(path.join(dir, 'dist', 'client.js'), 'BUNDLE')
  await fs.writeFile(
    path.join(dir, 'dist', 'built.json'),
    JSON.stringify({ commit: builtCommit, dirty: built.dirty, dirtyPaths: built.dirtyPaths ?? [], builtAt: 0 }),
  )
  return { folder, dir, builtCommit }
}

test('the record reports the running bundle commit apart from the checkout, after a new commit', async () => {
  const { folder, dir, builtCommit } = await builtFixture()

  // A commit lands after the build. The auto-rebuild would proceed (the tree is
  // clean), but until it does, the bundle is still the one built at the first
  // commit — which is what the record must say.
  await fs.writeFile(path.join(dir, 'src', 'client.tsx'), 'export default { hello: "moon" }\n')
  await run('git', ['add', '-A'], { cwd: dir })
  await run('git', ['-c', 'commit.gpgsign=false', 'commit', '-q', '-m', 'second'], { cwd: dir, env: GIT_ENV })
  const { stdout: headNow } = await run('git', ['rev-parse', 'HEAD'], { cwd: dir })

  const record = await getLocalExtensionImpl(folder)
  assert.ok(record, 'the extension record must load')
  assert.equal(record.builtCommit, builtCommit, 'builtCommit is the commit the running bundle was produced from')
  assert.equal(record.sourceCommit, headNow.trim(), 'sourceCommit is the checkout HEAD, which has moved on')
  assert.notEqual(record.builtCommit, record.sourceCommit, 'the two must be visibly different, not conflated')
  assert.equal(record.builtDirty, false, 'a bundle built from a clean tree reports so')
  assert.equal(record.refusal, null, 'a clean checkout ahead of the bundle is not itself a refusal')
})

test('a bundle built from a dirty tree says so, so its commit is not read as an exact identity', async () => {
  // The compile_extension(allowUnclean) case: builtCommit names a commit, but
  // the tree had uncommitted work on top when the bundle was produced.
  const { folder, builtCommit } = await builtFixture({ dirty: true, dirtyPaths: ['src/client.tsx'] })

  const record = await getLocalExtensionImpl(folder)
  assert.ok(record, 'the extension record must load')
  assert.equal(record.builtCommit, builtCommit, 'the commit is still recorded')
  assert.equal(record.builtDirty, true, 'but the bundle is marked as built from a dirty tree')
  assert.deepEqual(record.builtDirtyPaths, ['src/client.tsx'], 'and it says which paths were uncommitted at build time')
})

test('the record carries the refusal that holds the bundle apart from a dirty checkout', async () => {
  const { folder, dir, builtCommit } = await builtFixture()

  // An uncommitted edit: the auto-rebuild would refuse to publish it, so the
  // record must both keep reporting the built commit and say why.
  await fs.appendFile(path.join(dir, 'src', 'client.tsx'), '// edit in progress\n')

  const record = await getLocalExtensionImpl(folder)
  assert.ok(record, 'the extension record must load')
  assert.equal(record.builtCommit, builtCommit, 'the running bundle is still the one built before the edit')
  assert.ok(record.refusal, 'a dirty checkout must surface a refusal on the record')
  assert.ok(record.refusal.reasons.includes('unclean'), 'and it names the uncommitted change as the reason')
})

// Exercises the real mechanism at stake: whether the reported build identity
// can drift when the checkout on disk moves without the process restarting.
// A mocked git call would hide exactly that — this shells out to a real
// scratch git repo and calls resolveBuildInfo() again after moving HEAD,
// the same sequence the bug report itself prescribes as the verification.
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { promises as fs } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import test, { after } from 'node:test'

import { gitFixture } from '@/test-support/git-fixture'
import { resolveBuildInfo } from './build-info'

const originalEnv = {
  OPENCROFT_BRANCH: process.env.OPENCROFT_BRANCH,
  OPENCROFT_COMMIT: process.env.OPENCROFT_COMMIT,
  OPENCROFT_DEPLOYED_AT: process.env.OPENCROFT_DEPLOYED_AT,
}
const originalCwd = process.cwd()

after(() => {
  Object.assign(process.env, originalEnv)
  process.chdir(originalCwd)
})

test('env vars captured at deploy time win, even if the checkout moves later', async (t) => {
  const repo = gitFixture(t)
  await fs.writeFile(path.join(repo.dir, 'a.txt'), 'one')
  const deployedCommit = repo.commitAll('first')

  process.env.OPENCROFT_BRANCH = 'stage'
  process.env.OPENCROFT_COMMIT = deployedCommit
  process.env.OPENCROFT_DEPLOYED_AT = '2026-01-01T00:00:00Z'
  process.chdir(repo.dir)

  const atDeploy = resolveBuildInfo()
  assert.equal(atDeploy.commit, deployedCommit)
  assert.equal(atDeploy.branch, 'stage')
  assert.equal(atDeploy.deployedAt, '2026-01-01T00:00:00Z')

  // Move the checkout forward without "restarting" (without re-reading env).
  await fs.writeFile(path.join(repo.dir, 'a.txt'), 'two')
  const movedCommit = repo.commitAll('second')
  assert.notEqual(movedCommit, deployedCommit, 'setup sanity: the checkout must actually have moved')

  const afterMove = resolveBuildInfo()
  assert.equal(afterMove.commit, deployedCommit, 'must still report what was deployed, not what the checkout moved to')
})

test('falls back to reading the checkout only when no deploy env vars are set', async (t) => {
  const repo = gitFixture(t)
  await fs.writeFile(path.join(repo.dir, 'a.txt'), 'one')
  const commit = repo.commitAll('first')

  delete process.env.OPENCROFT_BRANCH
  delete process.env.OPENCROFT_COMMIT
  delete process.env.OPENCROFT_DEPLOYED_AT
  process.chdir(repo.dir)

  const info = resolveBuildInfo()
  assert.equal(info.commit, commit)
  assert.equal(info.branch, 'main')
  assert.equal(info.deployedAt, null)
})

// The container image has no .git. Loading the module there must not print
// git's "not a git repository" to the log, so this loads it in a separate
// process, from a directory outside any checkout, and reads that process's
// stderr.
test('outside a git checkout it reports unknown and writes nothing to stderr', async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'build-info-no-git-'))
  const env: NodeJS.ProcessEnv = { ...process.env, GIT_CEILING_DIRECTORIES: path.dirname(dir) }
  delete env.OPENCROFT_BRANCH
  delete env.OPENCROFT_COMMIT
  delete env.OPENCROFT_DEPLOYED_AT
  const moduleUrl = new URL('./build-info.ts', import.meta.url).href
  const code = `const { resolveBuildInfo } = await import(${JSON.stringify(moduleUrl)}); console.log(JSON.stringify(resolveBuildInfo()))`
  // The child needs this process's loaders, but a runner names its preloads
  // by paths relative to the directory it started in, and the child runs in
  // a directory of its own. Resolve them against the directory the tests
  // began in, which is the one the runner meant.
  const execArgv = process.execArgv.map((arg, i, all) =>
    i > 0 && all[i - 1] === '--import' && arg.startsWith('.') ? path.resolve(originalCwd, arg) : arg,
  )

  const run = spawnSync(process.execPath, [...execArgv, '--input-type=module', '-e', code], {
    cwd: dir,
    env,
    encoding: 'utf-8',
  })

  await fs.rm(dir, { recursive: true, force: true })
  assert.equal(run.status, 0, run.stderr)
  assert.equal(run.stderr, '')
  assert.deepEqual(JSON.parse(run.stdout.trim().split('\n').at(-1) ?? ''), {
    branch: 'unknown',
    commit: 'unknown',
    deployedAt: null,
  })
})

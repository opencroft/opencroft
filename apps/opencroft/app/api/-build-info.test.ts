// Exercises the real mechanism at stake: whether the reported build identity
// can drift when the checkout on disk moves without the process restarting.
// A mocked git call would hide exactly that — this shells out to a real
// scratch git repo and calls resolveBuildInfo() again after moving HEAD,
// the same sequence the bug report itself prescribes as the verification.
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { promises as fs } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import test, { after } from 'node:test'

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

test('env vars captured at deploy time win, even if the checkout moves later', async () => {
  const repo = await fs.mkdtemp(path.join(os.tmpdir(), 'build-info-env-'))
  const git = (...args: string[]) => execFileSync('git', args, { cwd: repo, encoding: 'utf-8' })
  git('init', '-q')
  git('config', 'user.email', 'test@example.com')
  git('config', 'user.name', 'test')
  await fs.writeFile(path.join(repo, 'a.txt'), 'one')
  git('add', '.')
  git('commit', '-q', '-m', 'first')
  const deployedCommit = git('rev-parse', 'HEAD').trim()

  process.env.OPENCROFT_BRANCH = 'stage'
  process.env.OPENCROFT_COMMIT = deployedCommit
  process.env.OPENCROFT_DEPLOYED_AT = '2026-01-01T00:00:00Z'
  process.chdir(repo)

  const atDeploy = resolveBuildInfo()
  assert.equal(atDeploy.commit, deployedCommit)
  assert.equal(atDeploy.branch, 'stage')
  assert.equal(atDeploy.deployedAt, '2026-01-01T00:00:00Z')

  // Move the checkout forward without "restarting" (without re-reading env).
  await fs.writeFile(path.join(repo, 'a.txt'), 'two')
  git('commit', '-q', '-am', 'second')
  const movedCommit = git('rev-parse', 'HEAD').trim()
  assert.notEqual(movedCommit, deployedCommit, 'setup sanity: the checkout must actually have moved')

  const afterMove = resolveBuildInfo()
  assert.equal(afterMove.commit, deployedCommit, 'must still report what was deployed, not what the checkout moved to')

  await fs.rm(repo, { recursive: true, force: true })
})

test('falls back to reading the checkout only when no deploy env vars are set', async () => {
  const repo = await fs.mkdtemp(path.join(os.tmpdir(), 'build-info-fallback-'))
  const git = (...args: string[]) => execFileSync('git', args, { cwd: repo, encoding: 'utf-8' })
  git('init', '-q', '-b', 'main')
  git('config', 'user.email', 'test@example.com')
  git('config', 'user.name', 'test')
  await fs.writeFile(path.join(repo, 'a.txt'), 'one')
  git('add', '.')
  git('commit', '-q', '-m', 'first')
  const commit = git('rev-parse', 'HEAD').trim()

  delete process.env.OPENCROFT_BRANCH
  delete process.env.OPENCROFT_COMMIT
  delete process.env.OPENCROFT_DEPLOYED_AT
  process.chdir(repo)

  const info = resolveBuildInfo()
  assert.equal(info.commit, commit)
  assert.equal(info.branch, 'main')
  assert.equal(info.deployedAt, null)

  await fs.rm(repo, { recursive: true, force: true })
})

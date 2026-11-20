// gitFixture() on a machine whose git config is set against it: signing on
// with a signer that always fails, an upstream for every new branch, another
// default branch name, and no identity unless one is configured.

import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { existsSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test, { after, before } from 'node:test'

import { gitFixture } from './git-fixture'

const HOSTILE_CONFIG = [
  '[user]',
  '\tuseConfigOnly = true',
  '[commit]',
  '\tgpgsign = true',
  '[tag]',
  '\tgpgsign = true',
  '[gpg]',
  '\tprogram = false',
  '[branch]',
  '\tautoSetupMerge = always',
  '[push]',
  '\tautoSetupRemote = true',
  '[init]',
  '\tdefaultBranch = trunk',
  '',
].join('\n')

// Planted both ways git finds a user's config: the home directory, and
// GIT_CONFIG_GLOBAL already exported by the caller.
const home = mkdtempSync(join(tmpdir(), 'git-fixture-hostile-home-'))
writeFileSync(join(home, '.gitconfig'), HOSTILE_CONFIG)
const saved = { HOME: process.env.HOME, GIT_CONFIG_GLOBAL: process.env.GIT_CONFIG_GLOBAL }
before(() => {
  process.env.HOME = home
  process.env.GIT_CONFIG_GLOBAL = join(home, '.gitconfig')
})
after(() => {
  for (const [name, value] of Object.entries(saved)) {
    if (value === undefined) delete process.env[name]
    else process.env[name] = value
  }
  rmSync(home, { recursive: true, force: true })
})

/** git as the code under test runs it: with this process's environment, planted config included. */
function plainGit(cwd: string, ...args: string[]) {
  return spawnSync('git', args, { cwd, env: process.env, encoding: 'utf8' })
}

test('the planted config breaks plain git: a commit needs an identity and a signature it cannot get', () => {
  const dir = mkdtempSync(join(tmpdir(), 'git-fixture-control-'))
  try {
    assert.equal(plainGit(dir, 'init', '-q').status, 0)
    assert.equal(plainGit(dir, 'symbolic-ref', '--short', 'HEAD').stdout.trim(), 'trunk')
    const commit = plainGit(
      dir,
      '-c',
      'user.name=x',
      '-c',
      'user.email=x@example.com',
      'commit',
      '--allow-empty',
      '-m',
      'x',
    )
    assert.notEqual(commit.status, 0, 'signing was on, with a signer that fails')
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('a fixture commits and tags on main as its own identity, unsigned, under the planted config', (t) => {
  const repo = gitFixture(t)
  writeFileSync(join(repo.dir, 'a.txt'), 'one')

  const sha = repo.commitAll('first')
  repo.git('tag', 'v1.0.0')

  assert.match(sha, /^[0-9a-f]{40}$/)
  assert.equal(repo.git('symbolic-ref', '--short', 'HEAD').trim(), 'main')
  assert.equal(repo.git('log', '-1', '--format=%an <%ae> %G?').trim(), 'test <test@example.com> N')
  assert.equal(repo.git('rev-parse', 'v1.0.0^{commit}').trim(), sha)
})

test('a branch cut in a clone of a fixture gets no upstream from the planted autoSetupMerge', (t) => {
  const repo = gitFixture(t)
  repo.commitAll('first')
  const clone = join(repo.root, 'clone')
  repo.gitIn(repo.root, 'clone', '-q', repo.dir, clone)

  repo.gitIn(clone, 'checkout', '-q', '-b', 'task')

  const upstream = spawnSync('git', ['config', '--get', 'branch.task.merge'], { cwd: clone, env: repo.env })
  assert.equal(upstream.status, 1, 'no branch.task.merge was written')
})

test("git that the code under test runs in a fixture's repository commits and tags unsigned", (t) => {
  const repo = gitFixture(t)

  assert.equal(plainGit(repo.dir, 'commit', '-q', '--allow-empty', '-m', 'by the code').status, 0)
  assert.equal(plainGit(repo.dir, 'tag', '-a', 'v2.0.0', '-m', 'release').status, 0)
  assert.equal(repo.git('log', '-1', '--format=%an %G?').trim(), 'test N')
})

test('a bare fixture is a bare repository a clone can push to', (t) => {
  const remote = gitFixture(t, { bare: true })
  const work = gitFixture(t)
  work.commitAll('first')

  work.git('push', '-q', remote.dir, 'main')

  assert.equal(remote.git('rev-parse', '--is-bare-repository').trim(), 'true')
  assert.equal(remote.git('rev-parse', 'main').trim(), work.git('rev-parse', 'HEAD').trim())
})

test('a git call that fails fails the test with what git said', (t) => {
  const repo = gitFixture(t)

  assert.throws(() => repo.git('rev-parse', 'no-such-ref'), /git rev-parse no-such-ref in .*no-such-ref/s)
})

test('teardown removes the whole temporary directory', () => {
  const teardowns: Array<() => void> = []
  const repo = gitFixture({ after: (fn) => teardowns.push(fn) })
  repo.commitAll('first')
  assert.equal(existsSync(repo.root), true)

  for (const fn of teardowns) fn()

  assert.equal(existsSync(repo.root), false)
})

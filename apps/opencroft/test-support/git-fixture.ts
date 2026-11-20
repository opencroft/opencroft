// A git repository for a test, in a temporary directory of its own, that the
// machine it runs on cannot reach into.
//
// git reads the user's and the system's config on every call, so a test that
// runs plain `git` takes on whatever the machine has set: signing on (commits
// and tags then fail, or open an editor), `branch.autoSetupMerge` writing an
// upstream the test meant to leave unset, `init.defaultBranch` renaming the
// branch the test names, no identity at all. Every git call made through the
// fixture runs with that config switched off and an identity of its own, and
// the repository's own config repeats the identity and the signing switch, so
// git that the code under test runs in it commits and tags the same way.

import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const IDENTITY = { name: 'test', email: 'test@example.com' }

/**
 * What every git call of a fixture runs with on top of the caller's
 * environment, whose own GIT_* variables are dropped first.
 */
export const GIT_ISOLATION_ENV = {
  GIT_CONFIG_GLOBAL: '/dev/null',
  GIT_CONFIG_NOSYSTEM: '1',
  GIT_TERMINAL_PROMPT: '0',
  GIT_AUTHOR_NAME: IDENTITY.name,
  GIT_AUTHOR_EMAIL: IDENTITY.email,
  GIT_COMMITTER_NAME: IDENTITY.name,
  GIT_COMMITTER_EMAIL: IDENTITY.email,
}

/** Where the fixture's teardown is registered: a test's context, or `{ after }` from node:test for a whole file. */
export interface TeardownScope {
  after(fn: () => void): void
}

export interface GitFixtureOptions {
  /** A bare repository, as a remote to clone from and push to. */
  bare?: boolean
  /** The branch the repository starts on. Default `main`. */
  branch?: string
}

export interface GitFixture {
  /** The temporary directory, removed in teardown. Clones and other scratch go here. */
  root: string
  /** The repository, inside `root`. */
  dir: string
  /** The environment the fixture's git calls run with, for a test that spawns git itself. */
  env: NodeJS.ProcessEnv
  /** Runs git in the repository and returns its stdout; a non-zero exit fails the test with git's stderr. */
  git(...args: string[]): string
  /** The same, in another directory: a clone made in `root`, say. */
  gitIn(cwd: string, ...args: string[]): string
  /** Stages everything in the repository and commits it; returns the new commit's sha. */
  commitAll(message: string): string
}

/**
 * Makes a repository in a new temporary directory and registers its removal
 * with `scope`.
 */
export function gitFixture(scope: TeardownScope, options: GitFixtureOptions = {}): GitFixture {
  const root = mkdtempSync(join(tmpdir(), 'git-fixture-'))
  scope.after(() => rmSync(root, { recursive: true, force: true }))

  const env = isolatedGitEnv()
  const gitIn = (cwd: string, ...args: string[]): string => {
    const result = spawnSync('git', args, { cwd, env, encoding: 'utf8' })
    assert.equal(result.status, 0, `git ${args.join(' ')} in ${cwd}: ${result.error?.message ?? result.stderr}`)
    return result.stdout
  }

  const dir = join(root, 'repo')
  gitIn(root, 'init', '-q', ...(options.bare ? ['--bare'] : []), '-b', options.branch ?? 'main', dir)
  for (const [key, value] of [
    ['user.name', IDENTITY.name],
    ['user.email', IDENTITY.email],
    ['commit.gpgsign', 'false'],
    ['tag.gpgsign', 'false'],
  ]) {
    gitIn(dir, 'config', key, value)
  }

  const git = (...args: string[]) => gitIn(dir, ...args)
  const commitAll = (message: string): string => {
    git('add', '-A')
    git('commit', '-q', '--allow-empty', '-m', message)
    return git('rev-parse', 'HEAD').trim()
  }
  return { root, dir, env, git, gitIn, commitAll }
}

/**
 * This process's environment without its GIT_* variables, plus
 * GIT_ISOLATION_ENV: what a fixture's git calls run with, for a test whose own
 * git helper makes repositories somewhere a fixture cannot.
 */
export function isolatedGitEnv(): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {}
  for (const [name, value] of Object.entries(process.env)) {
    if (!name.startsWith('GIT_')) env[name] = value
  }
  return { ...env, ...GIT_ISOLATION_ENV }
}

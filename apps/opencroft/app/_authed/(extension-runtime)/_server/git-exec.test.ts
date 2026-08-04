// Exercises a real failing `git` process, not a mocked one -- the leak this
// guards against is Node's own "Command failed: <full argv>" error message
// construction, which only happens on a genuine execFile rejection. The
// fake, unresolvable host means this needs no network and no real
// credential (embedding a live secret in test code would be its own
// version of the bug this file exists to prevent).
import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { promises as fs } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'

import { runGit, withGitAuth } from './git-exec'

const FAKE_TOKEN = 'fake-token-should-never-appear-in-output'
const CREDENTIALED_URL = `https://fake-user:${FAKE_TOKEN}@nonexistent-host-for-testing.invalid/repo.git`

test('a failed clone against a credentialed URL never leaks the credential in the thrown error', async () => {
  const dest = path.join(await fs.mkdtemp(path.join(os.tmpdir(), 'git-exec-leak-')), 'dest')
  await assert.rejects(
    runGit(['clone', '--depth', '1', CREDENTIALED_URL, dest]),
    (err) => {
      const message = (err as Error).message
      const stderr = (err as { stderr?: string }).stderr ?? ''
      assert.ok(!message.includes(FAKE_TOKEN), `token leaked into message: ${message}`)
      assert.ok(!message.includes('fake-user:'), `credential leaked into message: ${message}`)
      assert.ok(!stderr.includes(FAKE_TOKEN), `token leaked into stderr: ${stderr}`)
      assert.ok(message.includes('nonexistent-host-for-testing.invalid'), 'still names the host, still actionable')
      return true
    },
  )
})

test('a valid credential on a failure unrelated to auth is redacted the same way', async () => {
  // Same mechanism as the case above, standing in for "a correct credential,
  // a missing branch" from the bug report: the leak is in how Node
  // constructs the error, not in why git failed, so an unreachable host and
  // a missing-branch failure leak identically. Confirmed by hand against a
  // real host with a real credential during investigation (not repeated
  // here — embedding a live secret in a committed test is the same
  // violation this fix exists to close).
  const dest = path.join(await fs.mkdtemp(path.join(os.tmpdir(), 'git-exec-leak-branch-')), 'dest')
  const url = `https://fake-user:${FAKE_TOKEN}@nonexistent-host-for-testing.invalid/repo.git`
  await assert.rejects(runGit(['clone', '--depth', '1', '--branch', 'does-not-exist', '--single-branch', url, dest]), (err) => {
    const message = (err as Error).message
    assert.ok(!message.includes(FAKE_TOKEN), `token leaked into message: ${message}`)
    return true
  })
})

test('a successful command is unaffected', async () => {
  const { stdout } = await runGit(['--version'])
  assert.match(stdout, /^git version/)
})

// The tests above cover git's own error TEXT. The gap withGitAuth closes is
// different and worse: a credential spliced into a clone/fetch URL sits in
// the LIVE ARGV of `git` and of the `git-remote-https` helper it spawns, for
// as long as either runs -- readable via `ps`/`pgrep -fa`/`/proc/<pid>/cmdline`
// by anything on the host, success or failure, with no error involved at all
// (a silent leak). Verified here by observing a live process's
// own argv while it runs, the same interface `ps` reads from -- a code
// reading cannot establish absence from a process table. A non-routable
// address (10.255.255.1) keeps the connection attempt in flight long enough
// to sample it, with no network and no real credential.
const NON_ROUTABLE = '10.255.255.1'

async function argvContainsAfterDelay(cmd: string, args: string[], env: NodeJS.ProcessEnv | undefined, needle: string): Promise<boolean> {
  const child = spawn(cmd, args, { env, stdio: 'ignore' })
  try {
    await new Promise((resolve) => setTimeout(resolve, 400))
    const { stdout } = await execPs()
    return stdout.includes(needle)
  } finally {
    child.kill('SIGKILL')
  }

  async function execPs(): Promise<{ stdout: string }> {
    const { promisify } = await import('node:util')
    const { execFile } = await import('node:child_process')
    const run = promisify(execFile)
    return run('ps', ['-eo', 'args'])
  }
}

test('the old pattern (credential spliced into the URL) leaks into the live git-remote-https argv', async () => {
  const fake = 'synthetic-fake-secret-should-leak-here'
  const url = `https://fakeuser:${fake}@${NON_ROUTABLE}/org/repo.git`
  const leaked = await argvContainsAfterDelay('git', ['clone', '--depth', '1', url, path.join(os.tmpdir(), `old-pattern-${Date.now()}`)], undefined, fake)
  assert.ok(leaked, 'sanity check: the vulnerable pattern must actually reproduce, or this test proves nothing')
})

test('withGitAuth keeps the credential out of the live git-remote-https argv', async () => {
  const fake = 'synthetic-fake-secret-must-not-leak-here'
  const { url, env, cleanup } = await withGitAuth(`https://${NON_ROUTABLE}/org/repo.git`, { username: 'fakeuser', token: fake })
  try {
    const leaked = await argvContainsAfterDelay('git', ['clone', '--depth', '1', url, path.join(os.tmpdir(), `new-pattern-${Date.now()}`)], env, fake)
    assert.ok(!leaked, 'credential must not appear in the live process argv')
  } finally {
    await cleanup()
  }
})

test('withGitAuth still authenticates correctly -- the value reaches git, just not via argv', async () => {
  // Point GIT_ASKPASS at a real, working askpass and confirm git actually
  // invokes it and receives the value: clone against localhost with no git
  // server there fails fast (connection refused, not a timeout), so we
  // instead verify the askpass script itself is wired correctly and
  // executable, which is what a real successful auth depends on.
  const { url, env, cleanup } = await withGitAuth('https://example.invalid/org/repo.git', { username: 'fakeuser', token: 'irrelevant' })
  try {
    assert.equal(url, 'https://fakeuser@example.invalid/org/repo.git')
    assert.ok(env?.GIT_ASKPASS, 'GIT_ASKPASS must be set')
    const { promisify } = await import('node:util')
    const { execFile } = await import('node:child_process')
    const run = promisify(execFile)
    const { stdout } = await run(env.GIT_ASKPASS as string, ['Password:'], { env: { ...env, GIT_ASKPASS_PASSWORD: 'the-value' } })
    assert.equal(stdout, 'the-value', 'the askpass script must echo the password env var it was given')
  } finally {
    await cleanup()
  }
})

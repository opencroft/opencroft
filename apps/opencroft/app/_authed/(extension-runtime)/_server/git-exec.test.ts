// Exercises a real failing `git` process, not a mocked one -- the leak this
// guards against is Node's own "Command failed: <full argv>" error message
// construction, which only happens on a genuine execFile rejection. The
// fake, unresolvable host means this needs no network and no real
// credential (embedding a live secret in test code would be its own
// version of the bug this file exists to prevent).
import assert from 'node:assert/strict'
import { promises as fs } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'

import { runGit } from './git-exec'

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

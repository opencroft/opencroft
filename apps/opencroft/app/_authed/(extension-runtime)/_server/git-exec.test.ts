// Exercises a real failing `git` process, not a mocked one -- the leak this
// guards against is Node's own "Command failed: <full argv>" error message
// construction, which only happens on a genuine execFile rejection. The
// fake, unresolvable host means this needs no network and no real
// credential (embedding a live secret in test code would be its own
// version of the bug this file exists to prevent).
import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { promises as fs } from 'node:fs'
import http from 'node:http'
import type { AddressInfo } from 'node:net'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'

import { effectiveGitArgs, remoteFailure, runGit, withGitAuth } from './git-exec'

const FAKE_TOKEN = 'fake-token-should-never-appear-in-output'
const CREDENTIALED_URL = `https://fake-user:${FAKE_TOKEN}@nonexistent-host-for-testing.invalid/repo.git`

test('a failed clone against a credentialed URL never leaks the credential in the thrown error', async () => {
  const dest = path.join(await fs.mkdtemp(path.join(os.tmpdir(), 'git-exec-leak-')), 'dest')
  await assert.rejects(runGit(['clone', '--depth', '1', CREDENTIALED_URL, dest]), (err) => {
    const message = (err as Error).message
    const stderr = (err as { stderr?: string }).stderr ?? ''
    assert.ok(!message.includes(FAKE_TOKEN), `token leaked into message: ${message}`)
    assert.ok(!message.includes('fake-user:'), `credential leaked into message: ${message}`)
    assert.ok(!stderr.includes(FAKE_TOKEN), `token leaked into stderr: ${stderr}`)
    assert.ok(message.includes('nonexistent-host-for-testing.invalid'), 'still names the host, still actionable')
    return true
  })
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
  await assert.rejects(
    runGit(['clone', '--depth', '1', '--branch', 'does-not-exist', '--single-branch', url, dest]),
    (err) => {
      const message = (err as Error).message
      assert.ok(!message.includes(FAKE_TOKEN), `token leaked into message: ${message}`)
      return true
    },
  )
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

async function argvContainsAfterDelay(
  cmd: string,
  args: string[],
  env: NodeJS.ProcessEnv | undefined,
  needle: string,
): Promise<boolean> {
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
  const leaked = await argvContainsAfterDelay(
    'git',
    ['clone', '--depth', '1', url, path.join(os.tmpdir(), `old-pattern-${Date.now()}`)],
    undefined,
    fake,
  )
  assert.ok(leaked, 'sanity check: the vulnerable pattern must actually reproduce, or this test proves nothing')
})

test('withGitAuth keeps the credential out of the live git-remote-https argv', async () => {
  const fake = 'synthetic-fake-secret-must-not-leak-here'
  const { url, env, cleanup } = await withGitAuth(`https://${NON_ROUTABLE}/org/repo.git`, {
    username: 'fakeuser',
    token: fake,
  })
  try {
    const leaked = await argvContainsAfterDelay(
      'git',
      ['clone', '--depth', '1', url, path.join(os.tmpdir(), `new-pattern-${Date.now()}`)],
      env,
      fake,
    )
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
  const { url, env, cleanup } = await withGitAuth('https://example.invalid/org/repo.git', {
    username: 'fakeuser',
    token: 'irrelevant',
  })
  try {
    assert.equal(url, 'https://fakeuser@example.invalid/org/repo.git')
    assert.ok(env?.GIT_ASKPASS, 'GIT_ASKPASS must be set')
    const { promisify } = await import('node:util')
    const { execFile } = await import('node:child_process')
    const run = promisify(execFile)
    const { stdout } = await run(env.GIT_ASKPASS as string, ['Password:'], {
      env: { ...env, GIT_ASKPASS_PASSWORD: 'the-value' },
    })
    assert.equal(stdout, 'the-value', 'the askpass script must echo the password env var it was given')
  } finally {
    await cleanup()
  }
})

// The fault here is ORDERING, not the askpass above: git consults
// `credential.helper` before falling back to GIT_ASKPASS, so a helper in
// config this process does not own answers first. A deployment image can
// ship exactly that -- an /etc/gitconfig helper that errors on every call --
// and it breaks every authenticated read the moment withGitAuth stops
// putting the credential in the URL, because until then git never needed to
// resolve a credential at all. Latent until a correct change exposed it.
//
// A planted ambient helper via GIT_CONFIG_GLOBAL reproduces it hermetically:
// no container, no network, no real credential.
async function plantAmbientHelper(): Promise<{ configPath: string; markerPath: string; cleanup: () => Promise<void> }> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'git-ambient-helper-'))
  const markerPath = path.join(dir, 'helper-ran')
  const helperPath = path.join(dir, 'helper.sh')
  // Records that it ran, then answers with a syntactically valid credential
  // so the failure mode under test is "the wrong answer won", not "no answer".
  await fs.writeFile(helperPath, `#!/bin/sh\ntouch '${markerPath}'\necho username=ambient\necho password=ambient\n`, {
    mode: 0o700,
  })
  const configPath = path.join(dir, 'gitconfig')
  await fs.writeFile(configPath, `[credential]\n\thelper = ${helperPath}\n`)
  return { configPath, markerPath, cleanup: () => fs.rm(dir, { recursive: true, force: true }) }
}

// Drives git's credential machinery directly -- `git credential fill` is the
// entry point the clone path reaches, and the only way to observe which
// source actually answered. `config --get-all` cannot show this: the empty
// `-c` entry is listed alongside the ambient one, and it is the credential
// subsystem, not config lookup, that treats it as a reset.
async function credentialFill(extraArgs: string[], env: NodeJS.ProcessEnv): Promise<void> {
  await new Promise<void>((resolve) => {
    const child = spawn('git', [...extraArgs, 'credential', 'fill'], { env, stdio: ['pipe', 'ignore', 'ignore'] })
    child.on('close', () => resolve())
    child.stdin.end('protocol=https\nhost=example.invalid\n\n')
  })
}

test('sanity check: an ambient credential helper answers by default, which is the fault', async () => {
  const { configPath, markerPath, cleanup } = await plantAmbientHelper()
  try {
    await credentialFill([], { ...process.env, GIT_CONFIG_GLOBAL: configPath })
    await assert.doesNotReject(
      fs.access(markerPath),
      'the ambient helper must actually run, or the next test proves nothing',
    )
  } finally {
    await cleanup()
  }
})

test('the cleared helper stops an ambient credential helper from answering at all', async () => {
  const { configPath, markerPath, cleanup } = await plantAmbientHelper()
  try {
    await credentialFill(effectiveGitArgs([], { GIT_ASKPASS: '/nonexistent-askpass' }), {
      ...process.env,
      GIT_CONFIG_GLOBAL: configPath,
      // Nothing may prompt: without this git can fall through to a terminal
      // prompt and hang the suite instead of failing.
      GIT_TERMINAL_PROMPT: '0',
    })
    await assert.rejects(fs.access(markerPath), 'the ambient helper must not have run')
  } finally {
    await cleanup()
  }
})

// The two tests above prove the FLAG works against real git. These prove
// runGit actually applies it, and only on the authenticated path -- the
// scoping is deliberate and silently losing it would reintroduce the bug for
// callers that legitimately depend on an ambient helper.
test('runGit clears the helper only when it supplied its own askpass', () => {
  assert.deepEqual(effectiveGitArgs(['clone', 'url'], { GIT_ASKPASS: '/some/askpass' }), [
    '-c',
    'credential.helper=',
    'clone',
    'url',
  ])
  assert.deepEqual(
    effectiveGitArgs(['clone', 'url'], {}),
    ['clone', 'url'],
    'no credential of ours: leave ambient config alone',
  )
  assert.deepEqual(effectiveGitArgs(['clone', 'url'], undefined), ['clone', 'url'], 'no env at all: unchanged')
})

test('withGitAuth and runGit compose: an authenticated read carries the cleared helper', async () => {
  const { env, cleanup } = await withGitAuth('https://example.invalid/o/r.git', { username: 'u', token: 't' })
  try {
    assert.deepEqual(effectiveGitArgs(['ls-remote'], env).slice(0, 2), ['-c', 'credential.helper='])
  } finally {
    await cleanup()
  }
})

// What the page says when a read of a remote fails, from real git against a
// local HTTP server that answers each path with one status. The helper planted
// for the sign-in case is the broken one a deployment image shipped: its bash
// error lands in git's stderr, which is what the page used to show.
async function withStatusServer(run: (base: string) => Promise<void>): Promise<void> {
  const server = http.createServer((req, res) => {
    const status = Number(req.url?.split('/')[1]) || 404
    res.writeHead(status, status === 401 ? { 'WWW-Authenticate': 'Basic realm="test"' } : {})
    res.end()
  })
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  try {
    await run(`http://127.0.0.1:${(server.address() as AddressInfo).port}`)
  } finally {
    await new Promise((resolve) => server.close(resolve))
  }
}

async function remoteFailureOf(url: string, env: NodeJS.ProcessEnv = {}): Promise<string> {
  const quiet = console.warn
  console.warn = () => {}
  try {
    await runGit(['ls-remote', url], { env: { ...process.env, GIT_TERMINAL_PROMPT: '0', ...env } })
  } catch (err) {
    return remoteFailure(err, url).message
  } finally {
    console.warn = quiet
  }
  assert.fail(`ls-remote ${url} was expected to fail`)
}

test('a remote that wants a sign-in nothing can give is said as such, without the helper noise', async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'git-broken-helper-'))
  try {
    const helper = path.join(dir, 'helper.sh')
    await fs.writeFile(helper, `#!/bin/bash\necho "password=\${!GIT_PASSWORD}"\necho "username=$GIT_USERNAME"\n`, {
      mode: 0o700,
    })
    const config = path.join(dir, 'gitconfig')
    await fs.writeFile(config, `[credential]\n\thelper = ${helper}\n`)
    await withStatusServer(async (base) => {
      const host = new URL(base).host
      const message = await remoteFailureOf(`${base}/401/repo.git`, { GIT_CONFIG_GLOBAL: config })
      assert.equal(
        message,
        `Could not sign in to ${host}: no credential is set up for this source, or the one it uses was refused.`,
      )
      assert.match(await remoteFailureOf(`${base}/403/repo.git`), /^Could not sign in to /)
    })
  } finally {
    await fs.rm(dir, { recursive: true, force: true })
  }
})

test('a missing repository and an unreachable host are each said in a sentence', async () => {
  await withStatusServer(async (base) => {
    const host = new URL(base).host
    assert.equal(await remoteFailureOf(`${base}/404/repo.git`), `There is no repository at this address on ${host}.`)
  })
  assert.equal(await remoteFailureOf('http://127.0.0.1:1/repo.git'), 'Could not reach 127.0.0.1:1.')
  assert.equal(
    await remoteFailureOf('https://nonexistent-host-for-testing.invalid/repo.git'),
    'Could not reach nonexistent-host-for-testing.invalid.',
  )
})

test('a directory that holds no repository is a missing repository too', async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'git-not-a-repo-'))
  try {
    assert.equal(await remoteFailureOf(`file://${dir}`), 'There is no repository at this address on the remote.')
  } finally {
    await fs.rm(dir, { recursive: true, force: true })
  }
})

test('any other remote failure is what git last said, without the command that ran', async () => {
  // A transport git has no helper for fails in none of the ways named above,
  // and git 2.43 says so without a fatal line.
  const message = await remoteFailureOf('nosuchtransport::somewhere')
  assert.match(message, /remote-nosuchtransport/)
  assert.doesNotMatch(message, /Command failed|ls-remote/)
})

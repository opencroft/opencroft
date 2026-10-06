// Where a development checkout stands against its branch on origin, and
// bringing it there, against a real local repository as origin and a real
// checkout installed from it. The extension is a manifest and a one-line server
// module with no package.json, so its build needs no npm.
//
// Each test has a data dir of its own; the database is the one the suite
// shares, so every folder carries a suffix and its row is removed afterwards.
import '@opencroft/db/test-env'

import assert from 'node:assert/strict'
import { execFile, spawnSync } from 'node:child_process'
import { promises as fs } from 'node:fs'
import http from 'node:http'
import type { AddressInfo } from 'node:net'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'
import { promisify } from 'node:util'

import { db, extension } from '@opencroft/db'
import { eq } from 'drizzle-orm'

import { installExtension } from '@/app/_authed/(extension-runtime)/_server/install'
import { checkLocalExtensionRemoteImpl, pullLocalExtensionImpl } from './local-extension-remote-impl'

const execFileAsync = promisify(execFile)

const hasGit = spawnSync('git', ['--version']).status === 0
const NO_GIT = 'git is not installed on this machine, and these tests need a real repository as origin'
const gitTest = (name: string, fn: () => Promise<void>) => test(name, { skip: hasGit ? false : NO_GIT }, fn)

const folder = `local.widgets-${crypto.randomUUID().slice(0, 8)}`

async function git(cwd: string, ...args: string[]): Promise<string> {
  // An identity and no signing on the command line, so no global git config
  // decides whether a commit can be made.
  const identity = ['-c', 'commit.gpgsign=false', '-c', 'user.name=a', '-c', 'user.email=a@example.com']
  const { stdout } = await execFileAsync('git', [...identity, ...args], { cwd })
  return stdout.trim()
}

/** Write `file` in `dir` and commit it; returns the new commit. */
async function commitFile(dir: string, file: string, content: string): Promise<string> {
  await fs.writeFile(path.join(dir, file), content)
  await git(dir, 'add', '-A')
  await git(dir, 'commit', '-q', '-m', `change ${file}`)
  return git(dir, 'rev-parse', 'HEAD')
}

interface Fixture {
  /** The repository the checkout was installed from: its origin. */
  origin: string
  checkout: string
}

/** An origin repository on `main` and a development checkout installed from it, in a data dir of its own. */
async function withCheckout(run: (fixture: Fixture) => Promise<void>): Promise<void> {
  const data = await fs.mkdtemp(path.join(os.tmpdir(), 'ext-local-remote-'))
  const savedDataDir = process.env.OPENCROFT_DATA_DIR
  process.env.OPENCROFT_DATA_DIR = data
  try {
    const origin = path.join(data, 'origin')
    await fs.mkdir(path.join(origin, 'server'), { recursive: true })
    await git(origin, 'init', '-q')
    // Pinned rather than inherited: the default branch name is a git setting.
    await git(origin, 'symbolic-ref', 'HEAD', 'refs/heads/main')
    await fs.writeFile(path.join(origin, 'extension.json'), JSON.stringify({ name: 'Widgets', version: '1.0.0' }))
    await fs.writeFile(path.join(origin, 'server', 'index.ts'), 'export const actions = {}\n')
    // What the build writes, ignored as extension repositories ignore it, so a
    // built checkout is a clean one.
    await commitFile(origin, '.gitignore', 'dist/\nnode_modules/\n')
    await installExtension({ folder, url: `file://${origin}`, asLocal: true })
    await run({ origin, checkout: path.join(data, 'extensions', folder) })
  } finally {
    if (savedDataDir === undefined) {
      delete process.env.OPENCROFT_DATA_DIR
    } else {
      process.env.OPENCROFT_DATA_DIR = savedDataDir
    }
    await db.delete(extension).where(eq(extension.folder, folder))
    await fs.rm(data, { recursive: true, force: true })
  }
}

gitTest('a checkout origin has moved past is behind, and the pull brings it there and rebuilds', async () => {
  await withCheckout(async ({ origin, checkout }) => {
    const tip = await commitFile(origin, 'notes.txt', 'newer')

    const state = await checkLocalExtensionRemoteImpl(folder)
    assert.equal(state.remoteCommit, tip)
    assert.equal(state.behind, true)
    assert.equal(state.blocked, null)

    const result = await pullLocalExtensionImpl(folder)
    assert.equal(result.moved, true)
    assert.equal(result.to, tip)
    assert.equal(result.build.success, true)
    assert.equal(await git(checkout, 'rev-parse', 'HEAD'), tip)
    assert.equal((await checkLocalExtensionRemoteImpl(folder)).behind, false)
  })
})

gitTest('a checkout with commits origin lacks, and origin unchanged, is ahead rather than behind', async () => {
  await withCheckout(async ({ checkout }) => {
    await commitFile(checkout, 'local.txt', 'mine')

    const state = await checkLocalExtensionRemoteImpl(folder)
    assert.equal(state.behind, false)
    assert.equal(state.blocked, null)
  })
})

gitTest('a diverged checkout whose origin commit was fetched is blocked with the reason', async () => {
  await withCheckout(async ({ origin, checkout }) => {
    await commitFile(origin, 'notes.txt', 'theirs')
    await commitFile(checkout, 'local.txt', 'mine')
    // An earlier fetch brought origin's commit in, so its history is readable.
    await git(checkout, 'fetch', '-q', 'origin')

    const state = await checkLocalExtensionRemoteImpl(folder)
    assert.equal(state.behind, true)
    assert.match(state.blocked ?? '', /cannot fast-forward/)
  })
})

gitTest('a diverged checkout whose origin commit was never fetched is refused by the pull, unchanged', async () => {
  await withCheckout(async ({ origin, checkout }) => {
    await commitFile(origin, 'notes.txt', 'theirs')
    const mine = await commitFile(checkout, 'local.txt', 'mine')

    // Without origin's commit the check cannot see the divergence: it reports
    // behind, and the pull is what finds out.
    const state = await checkLocalExtensionRemoteImpl(folder)
    assert.equal(state.behind, true)
    assert.equal(state.blocked, null)

    await assert.rejects(pullLocalExtensionImpl(folder), /cannot fast-forward/)
    assert.equal(await git(checkout, 'rev-parse', 'HEAD'), mine)
  })
})

gitTest('a remote that refuses sign-in is said in a sentence, not as the command and its stderr', async () => {
  await withCheckout(async ({ checkout }) => {
    // The checkout's recorded source becomes a server that wants a sign-in, and
    // the ambient credential helper is a broken one, as a deployment image can
    // ship.
    const server = http.createServer((_req, res) => {
      res.writeHead(401, { 'WWW-Authenticate': 'Basic realm="test"' })
      res.end()
    })
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
    const host = `127.0.0.1:${(server.address() as AddressInfo).port}`
    await db
      .update(extension)
      .set({ sourceUrl: `http://${host}/acme/widgets.git` })
      .where(eq(extension.folder, folder))
    const helperDir = await fs.mkdtemp(path.join(os.tmpdir(), 'git-broken-helper-'))
    const helper = path.join(helperDir, 'helper.sh')
    await fs.writeFile(helper, `#!/bin/bash\necho "password=\${!GIT_PASSWORD}"\n`, { mode: 0o700 })
    await fs.writeFile(path.join(helperDir, 'gitconfig'), `[credential]\n\thelper = ${helper}\n`)
    const savedConfig = process.env.GIT_CONFIG_GLOBAL
    process.env.GIT_CONFIG_GLOBAL = path.join(helperDir, 'gitconfig')
    const quiet = console.warn
    console.warn = () => {}
    try {
      const said = `Could not sign in to ${host}: no credential is set up for this source, or the one it uses was refused.`
      const state = await checkLocalExtensionRemoteImpl(folder)
      assert.equal(state.error, said)
      // What git and the helper printed is kept for the disclosure behind the sentence.
      assert.match(state.errorDetail ?? '', /invalid indirect expansion[\s\S]*could not read (Username|Password)/)
      await assert.rejects(pullLocalExtensionImpl(folder), (err: Error) => {
        assert.equal(err.message, said)
        assert.ok(!err.message.includes(checkout))
        return true
      })
    } finally {
      console.warn = quiet
      if (savedConfig === undefined) {
        delete process.env.GIT_CONFIG_GLOBAL
      } else {
        process.env.GIT_CONFIG_GLOBAL = savedConfig
      }
      await fs.rm(helperDir, { recursive: true, force: true })
      await new Promise((resolve) => server.close(resolve))
    }
  })
})

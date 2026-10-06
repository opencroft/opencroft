// What a shared extension folder currently is: which commit, whether anyone
// has authored changes in it, and which branch it sits on.
//
// The parsing is exercised as a pure function, and the reading against a real
// `git` checkout rather than a stub -- what it guards is that rev-parse and
// status --porcelain agree with the tree on disk, which only exists in the real
// interaction with git.

import assert from 'node:assert/strict'
import { execFile } from 'node:child_process'
import { promises as fs } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import test, { after } from 'node:test'
import { promisify } from 'node:util'

import { parseStatusLines, readCheckoutState } from './checkout-state'

const execFileAsync = promisify(execFile)

const root = await fs.mkdtemp(path.join(os.tmpdir(), 'ext-checkout-state-'))

after(async () => {
  await fs.rm(root, { recursive: true, force: true })
})

async function git(dir: string, args: string[]): Promise<void> {
  await execFileAsync('git', args, { cwd: dir })
}

async function makeRepo(name: string): Promise<string> {
  const dir = path.join(root, name)
  await fs.mkdir(dir, { recursive: true })
  await git(dir, ['init', '--quiet'])
  // Pinned rather than inherited: the default branch name is a git setting, and
  // a test that asserts on branches cannot depend on how the host is configured.
  await git(dir, ['symbolic-ref', 'HEAD', 'refs/heads/main'])
  await git(dir, ['config', 'user.email', 'test@example.com'])
  await git(dir, ['config', 'user.name', 'Test'])
  return dir
}

async function commitAll(dir: string, message: string): Promise<void> {
  await git(dir, ['add', '.'])
  await git(dir, ['commit', '--quiet', '-m', message])
}

// ── parseStatusLines ──────────────────────────────────────────────────

test('parseStatusLines reads the status code and the path separately', () => {
  assert.deepEqual(parseStatusLines('?? extra.txt\n M src/client.tsx\n'), [
    { code: '??', path: 'extra.txt' },
    { code: ' M', path: 'src/client.tsx' },
  ])
})

test('parseStatusLines resolves a rename to its destination', () => {
  assert.deepEqual(parseStatusLines('R  old/name.ts -> new/name.ts'), [{ code: 'R ', path: 'new/name.ts' }])
})

test('parseStatusLines strips the quoting git adds around unusual paths', () => {
  assert.deepEqual(parseStatusLines('?? "src/a file.ts"'), [{ code: '??', path: 'src/a file.ts' }])
})

test('parseStatusLines ignores blank lines rather than emitting empty entries', () => {
  assert.deepEqual(parseStatusLines('\n\n'), [])
})

// ── readCheckoutState, against real git ───────────────────────────────

const UNKNOWN = {
  sourceCommit: null,
  sourceDirty: null,
  sourceDirtyPaths: [],
  branch: null,
  defaultBranch: null,
}

test('a directory that is not a checkout reports unknown rather than raising', async () => {
  const dir = path.join(root, 'plain-dir')
  await fs.mkdir(dir, { recursive: true })
  assert.deepEqual(await readCheckoutState(dir), UNKNOWN)
})

test('a folder inside another repository, with none of its own, reports unknown', async () => {
  // git run in such a folder answers for the enclosing repository, so without
  // this the folder would report that repository's commit and its uncommitted
  // files as its own.
  const outer = await makeRepo('enclosing-repo')
  await fs.writeFile(path.join(outer, 'package.json'), '{}')
  await commitAll(outer, 'initial')
  const dir = path.join(outer, 'data', 'extensions', 'local.nested')
  await fs.mkdir(dir, { recursive: true })
  await fs.writeFile(path.join(dir, 'extension.json'), '{}')
  await fs.writeFile(path.join(outer, 'package.json'), '{"changed":true}')
  await fs.writeFile(path.join(outer, 'untracked.ts'), '')

  assert.deepEqual(await readCheckoutState(dir), UNKNOWN)
  assert.equal((await readCheckoutState(outer)).sourceDirty, true, 'the enclosing repository itself is dirty')
})

test('a repository reached through a symlinked path is still its own checkout', async (t) => {
  const dir = await makeRepo('symlink-target-repo')
  await fs.writeFile(path.join(dir, 'extension.json'), '{}')
  await commitAll(dir, 'initial')
  const link = path.join(root, 'symlink-to-repo')
  try {
    await fs.symlink(dir, link, 'dir')
  } catch {
    t.skip('this filesystem cannot create a directory symlink')
    return
  }

  assert.equal((await readCheckoutState(link)).sourceDirty, false)
})

test('a clean checkout reports its real commit, its branch, and no authored changes', async () => {
  const dir = await makeRepo('clean-repo')
  await fs.writeFile(path.join(dir, 'extension.json'), '{}')
  await commitAll(dir, 'initial')
  const { stdout: head } = await execFileAsync('git', ['rev-parse', 'HEAD'], { cwd: dir })

  const result = await readCheckoutState(dir)
  assert.equal(result.sourceCommit, head.trim())
  assert.equal(result.sourceDirty, false)
  assert.equal(result.branch, 'main')
})

test('an uncommitted edit to a tracked file reports dirty against the same commit', async () => {
  const dir = await makeRepo('dirty-repo')
  await fs.writeFile(path.join(dir, 'extension.json'), '{}')
  await commitAll(dir, 'initial')
  const { stdout: head } = await execFileAsync('git', ['rev-parse', 'HEAD'], { cwd: dir })

  await fs.writeFile(path.join(dir, 'extension.json'), '{"changed":true}')

  const result = await readCheckoutState(dir)
  assert.equal(
    result.sourceCommit,
    head.trim(),
    'the commit is still HEAD -- only the tree changed, not what it points at',
  )
  assert.equal(result.sourceDirty, true)
  assert.deepEqual(result.sourceDirtyPaths, ['extension.json'])
})

test('an untracked file makes a checkout dirty: nothing is discounted as build output', async () => {
  const dir = await makeRepo('untracked-repo')
  await fs.writeFile(path.join(dir, 'extension.json'), '{}')
  await commitAll(dir, 'initial')

  // The host writes nothing into a checkout outside dist/ and node_modules/,
  // both ignored by extension repositories, so an untracked file at the root is
  // somebody's work whatever its name.
  await fs.writeFile(path.join(dir, 'package-lock.json'), '{}')

  const result = await readCheckoutState(dir)
  assert.equal(result.sourceDirty, true)
  assert.deepEqual(result.sourceDirtyPaths, ['package-lock.json'])
})

test('a detached checkout reports HEAD as its branch, which is not the default one', async () => {
  const dir = await makeRepo('detached-repo')
  await fs.writeFile(path.join(dir, 'extension.json'), '{}')
  await commitAll(dir, 'initial')
  const { stdout: head } = await execFileAsync('git', ['rev-parse', 'HEAD'], { cwd: dir })
  await git(dir, ['checkout', '--quiet', head.trim()])

  const result = await readCheckoutState(dir)
  assert.equal(result.branch, 'HEAD')
})

test('a clone knows its default branch; a repository with no remote does not', async () => {
  const origin = await makeRepo('origin-repo')
  await fs.writeFile(path.join(origin, 'extension.json'), '{}')
  await commitAll(origin, 'initial')

  const clonePath = path.join(root, 'cloned-repo')
  await execFileAsync('git', ['clone', '--quiet', origin, clonePath])

  assert.equal((await readCheckoutState(clonePath)).defaultBranch, 'main')
  assert.equal(
    (await readCheckoutState(origin)).defaultBranch,
    null,
    'no remote means no opinion about a default branch -- unknown, not a mismatch',
  )
})

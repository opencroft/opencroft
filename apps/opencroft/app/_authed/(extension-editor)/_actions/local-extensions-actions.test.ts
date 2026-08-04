// readGitState is what makes a local extension's manifest
// answer "which commit is this" durably — exercised against a real `git`
// checkout rather than mocked, since what it guards (rev-parse and
// status --porcelain actually agreeing with the tree on disk) only exists
// in the real interaction with git, not in a stub of it.

import assert from 'node:assert/strict'
import { execFile } from 'node:child_process'
import { promises as fs } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import test, { after } from 'node:test'
import { promisify } from 'node:util'

const execFileAsync = promisify(execFile)

const { readGitState } = await import('./local-extensions-actions')

const root = await fs.mkdtemp(path.join(os.tmpdir(), 'ext-git-state-'))

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
  await git(dir, ['config', 'user.email', 'test@example.com'])
  await git(dir, ['config', 'user.name', 'Test'])
  return dir
}

test('readGitState: not a git checkout at all returns null, not a thrown error', async () => {
  const dir = path.join(root, 'plain-dir')
  await fs.mkdir(dir, { recursive: true })
  const state = await readGitState(dir)
  assert.deepEqual(state, { sourceCommit: null, sourceDirty: null })
})

test('readGitState: a clean checkout reports the real commit and dirty: false', async () => {
  const dir = await makeRepo('clean-repo')
  await fs.writeFile(path.join(dir, 'extension.json'), '{}')
  await git(dir, ['add', '.'])
  await git(dir, ['commit', '--quiet', '-m', 'initial'])
  const { stdout: head } = await execFileAsync('git', ['rev-parse', 'HEAD'], { cwd: dir })

  const state = await readGitState(dir)
  assert.equal(state.sourceCommit, head.trim())
  assert.equal(state.sourceDirty, false)
})

test('readGitState: uncommitted changes report dirty: true against the same commit', async () => {
  const dir = await makeRepo('dirty-repo')
  await fs.writeFile(path.join(dir, 'extension.json'), '{}')
  await git(dir, ['add', '.'])
  await git(dir, ['commit', '--quiet', '-m', 'initial'])
  const { stdout: head } = await execFileAsync('git', ['rev-parse', 'HEAD'], { cwd: dir })

  // Edit a tracked file without committing -- the exact state a dev/test
  // compile leaves a checkout in, and the case a bare commit hash alone
  // would misrepresent as authoritative.
  await fs.writeFile(path.join(dir, 'extension.json'), '{"changed":true}')

  const state = await readGitState(dir)
  assert.equal(
    state.sourceCommit,
    head.trim(),
    'the commit is still HEAD -- only the tree changed, not what it points at',
  )
  assert.equal(state.sourceDirty, true)
})

// What a shared extension folder currently is: which commit, whether anyone
// has authored changes in it, and which branch it sits on.
//
// The parsing is exercised as a pure function, and the reading against a real
// `git` checkout rather than a stub -- what it guards is that rev-parse and
// status --porcelain agree with the tree on disk, which only exists in the real
// interaction with git.

import assert from 'node:assert/strict'
import { promises as fs } from 'node:fs'
import path from 'node:path'
import test, { after } from 'node:test'

import { gitFixture } from '@/test-support/git-fixture'
import { parseStatusLines, readCheckoutState } from './checkout-state'

// On `main`, whatever the host's default branch is: the tests assert on branches.
const makeRepo = () => gitFixture({ after })

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
  // The fixture's temporary directory holds the repository but is none itself.
  const dir = path.join(makeRepo().root, 'plain-dir')
  await fs.mkdir(dir, { recursive: true })
  assert.deepEqual(await readCheckoutState(dir), UNKNOWN)
})

test('a folder inside another repository, with none of its own, reports unknown', async () => {
  // git run in such a folder answers for the enclosing repository, so without
  // this the folder would report that repository's commit and its uncommitted
  // files as its own.
  const repo = makeRepo()
  const outer = repo.dir
  await fs.writeFile(path.join(outer, 'package.json'), '{}')
  repo.commitAll('initial')
  const dir = path.join(outer, 'data', 'extensions', 'local.nested')
  await fs.mkdir(dir, { recursive: true })
  await fs.writeFile(path.join(dir, 'extension.json'), '{}')
  await fs.writeFile(path.join(outer, 'package.json'), '{"changed":true}')
  await fs.writeFile(path.join(outer, 'untracked.ts'), '')

  assert.deepEqual(await readCheckoutState(dir), UNKNOWN)
  assert.equal((await readCheckoutState(outer)).sourceDirty, true, 'the enclosing repository itself is dirty')
})

test('a repository reached through a symlinked path is still its own checkout', async (t) => {
  const repo = makeRepo()
  const dir = repo.dir
  await fs.writeFile(path.join(dir, 'extension.json'), '{}')
  repo.commitAll('initial')
  const link = path.join(repo.root, 'symlink-to-repo')
  try {
    await fs.symlink(dir, link, 'dir')
  } catch {
    t.skip('this filesystem cannot create a directory symlink')
    return
  }

  assert.equal((await readCheckoutState(link)).sourceDirty, false)
})

test('a clean checkout reports its real commit, its branch, and no authored changes', async () => {
  const repo = makeRepo()
  const dir = repo.dir
  await fs.writeFile(path.join(dir, 'extension.json'), '{}')
  const head = repo.commitAll('initial')

  const result = await readCheckoutState(dir)
  assert.equal(result.sourceCommit, head)
  assert.equal(result.sourceDirty, false)
  assert.equal(result.branch, 'main')
})

test('an uncommitted edit to a tracked file reports dirty against the same commit', async () => {
  const repo = makeRepo()
  const dir = repo.dir
  await fs.writeFile(path.join(dir, 'extension.json'), '{}')
  const head = repo.commitAll('initial')

  await fs.writeFile(path.join(dir, 'extension.json'), '{"changed":true}')

  const result = await readCheckoutState(dir)
  assert.equal(result.sourceCommit, head, 'the commit is still HEAD -- only the tree changed, not what it points at')
  assert.equal(result.sourceDirty, true)
  assert.deepEqual(result.sourceDirtyPaths, ['extension.json'])
})

test('an untracked file makes a checkout dirty: nothing is discounted as build output', async () => {
  const repo = makeRepo()
  const dir = repo.dir
  await fs.writeFile(path.join(dir, 'extension.json'), '{}')
  repo.commitAll('initial')

  // The host writes nothing into a checkout outside dist/ and node_modules/,
  // both ignored by extension repositories, so an untracked file at the root is
  // somebody's work whatever its name.
  await fs.writeFile(path.join(dir, 'package-lock.json'), '{}')

  const result = await readCheckoutState(dir)
  assert.equal(result.sourceDirty, true)
  assert.deepEqual(result.sourceDirtyPaths, ['package-lock.json'])
})

test('a detached checkout reports HEAD as its branch, which is not the default one', async () => {
  const repo = makeRepo()
  await fs.writeFile(path.join(repo.dir, 'extension.json'), '{}')
  const head = repo.commitAll('initial')
  repo.git('checkout', '--quiet', head)

  const result = await readCheckoutState(repo.dir)
  assert.equal(result.branch, 'HEAD')
})

test('a clone knows its default branch; a repository with no remote does not', async () => {
  const repo = makeRepo()
  const origin = repo.dir
  await fs.writeFile(path.join(origin, 'extension.json'), '{}')
  repo.commitAll('initial')

  const clonePath = path.join(repo.root, 'cloned-repo')
  repo.gitIn(repo.root, 'clone', '--quiet', origin, clonePath)

  assert.equal((await readCheckoutState(clonePath)).defaultBranch, 'main')
  assert.equal(
    (await readCheckoutState(origin)).defaultBranch,
    null,
    'no remote means no opinion about a default branch -- unknown, not a mismatch',
  )
})

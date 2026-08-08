// What a shared extension folder currently is: which commit, whether anyone
// has authored changes in it, and which branch it sits on.
//
// The parsing and the decision are exercised as pure functions, and the reading
// against a real `git` checkout rather than a stub -- what it guards is that
// rev-parse and status --porcelain agree with the tree on disk, which only
// exists in the real interaction with git.

import assert from 'node:assert/strict'
import { execFile } from 'node:child_process'
import { promises as fs } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import test, { after } from 'node:test'
import { promisify } from 'node:util'

import {
  type CheckoutState,
  COMPILE_OVERRIDE_PARAM,
  classifyDirtyEntries,
  parseStatusLines,
  readCheckoutState,
  refuseCompile,
} from './checkout-state'

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

function state(overrides: Partial<CheckoutState> = {}): CheckoutState {
  return {
    sourceCommit: 'abc1234',
    sourceDirty: false,
    sourceDirtyPaths: [],
    artifactPaths: [],
    branch: 'main',
    defaultBranch: 'main',
    ...overrides,
  }
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

// ── classifyDirtyEntries ──────────────────────────────────────────────

test('generated files are not authored changes', () => {
  const { sourcePaths, artifactPaths } = classifyDirtyEntries('?? package-lock.json\n?? installed.json\n')
  assert.deepEqual(sourcePaths, [], 'a folder holding only build output has nobody working in it')
  assert.deepEqual(artifactPaths, ['package-lock.json', 'installed.json'])
})

test('an authored change alongside generated files is still an authored change', () => {
  const { sourcePaths, artifactPaths } = classifyDirtyEntries('?? package-lock.json\n M server/index.ts\n')
  assert.deepEqual(sourcePaths, ['server/index.ts'])
  assert.deepEqual(artifactPaths, ['package-lock.json'])
})

test('a generated name deeper in the tree is an authored change, not build output', () => {
  // The generated files are written at the checkout root. A source file that
  // happens to share the name is somebody's code.
  const { sourcePaths, artifactPaths } = classifyDirtyEntries(' M src/fixtures/package-lock.json')
  assert.deepEqual(sourcePaths, ['src/fixtures/package-lock.json'])
  assert.deepEqual(artifactPaths, [])
})

// ── refuseCompile ─────────────────────────────────────────────────────

test('a clean checkout on its default branch compiles', () => {
  assert.equal(refuseCompile(state(), false), null)
})

test('authored changes are refused, and the message names them', () => {
  const refusal = refuseCompile(state({ sourceDirty: true, sourceDirtyPaths: ['server/index.ts'] }), false)
  assert.deepEqual(refusal?.reasons, ['unclean'])
  assert.match(refusal?.message ?? '', /server\/index\.ts/)
})

test('a non-default branch is refused, and the message names both branches', () => {
  const refusal = refuseCompile(state({ branch: 'dev/some-work' }), false)
  assert.deepEqual(refusal?.reasons, ['off-branch'])
  assert.match(refusal?.message ?? '', /dev\/some-work/)
  assert.match(refusal?.message ?? '', /main/)
})

test('both conditions are reported, not just the first one found', () => {
  const refusal = refuseCompile(
    state({ sourceDirty: true, sourceDirtyPaths: ['a.ts'], branch: 'dev/some-work' }),
    false,
  )
  assert.deepEqual(refusal?.reasons, ['unclean', 'off-branch'])
})

test('every refusal says how to proceed anyway', () => {
  const refusal = refuseCompile(state({ sourceDirty: true, sourceDirtyPaths: ['a.ts'] }), false)
  assert.match(refusal?.message ?? '', new RegExp(COMPILE_OVERRIDE_PARAM))
})

test('the override compiles whatever state the folder is in', () => {
  const worst = state({ sourceDirty: true, sourceDirtyPaths: ['a.ts'], branch: 'dev/some-work' })
  assert.equal(refuseCompile(worst, true), null)
})

test('an unknown branch is not treated as the wrong branch', () => {
  // A folder git can say nothing about built before this guard existed and has
  // to keep building: refusing on absent information blocks work blindly.
  assert.equal(refuseCompile(state({ branch: null, defaultBranch: null }), false), null)
})

test('an unknown default branch alone is not a mismatch', () => {
  assert.equal(refuseCompile(state({ branch: 'dev/some-work', defaultBranch: null }), false), null)
})

test('a folder full of build output still compiles', () => {
  // The whole point of separating generated files from authored ones: this is
  // the state most checkouts are in, and it must not be a refusal.
  const built = state({ sourceDirty: false, artifactPaths: ['package-lock.json'] })
  assert.equal(refuseCompile(built, false), null)
})

// ── readCheckoutState, against real git ───────────────────────────────

test('a directory that is not a checkout reports unknown rather than raising', async () => {
  const dir = path.join(root, 'plain-dir')
  await fs.mkdir(dir, { recursive: true })
  assert.deepEqual(await readCheckoutState(dir), {
    sourceCommit: null,
    sourceDirty: null,
    sourceDirtyPaths: [],
    artifactPaths: [],
    branch: null,
    defaultBranch: null,
  })
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

test('a checkout dirtied only by a build reports clean, and says what it discounted', async () => {
  const dir = await makeRepo('artifact-repo')
  await fs.writeFile(path.join(dir, 'extension.json'), '{}')
  await commitAll(dir, 'initial')

  // Exactly what running a build leaves behind, and the state most of these
  // folders are in at any moment.
  await fs.writeFile(path.join(dir, 'package-lock.json'), '{}')
  await fs.writeFile(path.join(dir, 'installed.json'), '{}')

  const result = await readCheckoutState(dir)
  assert.equal(result.sourceDirty, false, 'a build having run is not somebody working here')
  assert.deepEqual(result.artifactPaths.sort(), ['installed.json', 'package-lock.json'])
  assert.deepEqual(result.sourceDirtyPaths, [])
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

test('a clone parked on another branch is refused, end to end', async () => {
  const origin = await makeRepo('origin-for-branch')
  await fs.writeFile(path.join(origin, 'extension.json'), '{}')
  await commitAll(origin, 'initial')

  const clonePath = path.join(root, 'cloned-off-branch')
  await execFileAsync('git', ['clone', '--quiet', origin, clonePath])
  await git(clonePath, ['checkout', '--quiet', '-b', 'dev/some-work'])

  const refusal = refuseCompile(await readCheckoutState(clonePath), false)
  assert.deepEqual(refusal?.reasons, ['off-branch'])
})

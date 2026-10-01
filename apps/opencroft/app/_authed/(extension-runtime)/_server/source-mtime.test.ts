// The freshness walk behind every extension consultation: what it counts as a
// source, that an unchanged tree is answered without walking it again, that
// every kind of change under it is seen by the next check, and that checks
// overlapping in time share one walk of the same tree.

import assert from 'node:assert/strict'
import { promises as fs } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import test, { after } from 'node:test'

import { newestMtime, workspacePackagesMtime } from './source-mtime'

const root = await fs.mkdtemp(path.join(os.tmpdir(), 'source-mtime-'))

after(async () => {
  await fs.rm(root, { recursive: true, force: true })
})

let seq = 0

async function makeTree(): Promise<string> {
  seq += 1
  const dir = path.join(root, `tree-${seq}`)
  for (const sub of ['a/b', 'node_modules/pkg', 'dist']) {
    await fs.mkdir(path.join(dir, sub), { recursive: true })
  }
  for (const file of ['top.ts', 'a/one.ts', 'a/b/two.ts', 'node_modules/pkg/index.js', 'dist/client.js']) {
    await fs.writeFile(path.join(dir, file), '')
  }
  // Every entry at one known time, so each test decides what is newest.
  const base = new Date('2020-01-01T00:00:00Z')
  for (const entry of [
    'top.ts',
    'a/one.ts',
    'a/b/two.ts',
    'a/b',
    'a',
    'node_modules/pkg/index.js',
    'dist/client.js',
    '.',
  ]) {
    await fs.utimes(path.join(dir, entry), base, base)
  }
  return dir
}

async function touch(file: string, iso: string): Promise<void> {
  const time = new Date(iso)
  await fs.utimes(file, time, time)
}

const BASE = new Date('2020-01-01T00:00:00Z').getTime()

/** Run `body` counting the directory reads it causes: one per directory a walk visits. */
async function countingReaddirs<T>(body: () => Promise<T>): Promise<{ result: T; readdirs: number }> {
  const realReaddir = fs.readdir
  let readdirs = 0
  fs.readdir = ((...args: Parameters<typeof fs.readdir>) => {
    readdirs += 1
    return realReaddir(...args)
  }) as typeof fs.readdir
  try {
    const result = await body()
    return { result, readdirs }
  } finally {
    fs.readdir = realReaddir
  }
}

test('the newest mtime is found however deep it is', async () => {
  const dir = await makeTree()
  await touch(path.join(dir, 'a', 'b', 'two.ts'), '2021-06-01T00:00:00Z')

  assert.equal(await newestMtime(dir), new Date('2021-06-01T00:00:00Z').getTime())
})

test('node_modules and dist are not sources', async () => {
  const dir = await makeTree()
  await touch(path.join(dir, 'node_modules', 'pkg', 'index.js'), '2022-01-01T00:00:00Z')
  await touch(path.join(dir, 'dist', 'client.js'), '2022-01-01T00:00:00Z')

  assert.equal(await newestMtime(dir), BASE)
})

test('a missing path is 0, and a file is its own mtime', async () => {
  const dir = await makeTree()
  await touch(path.join(dir, 'top.ts'), '2021-03-01T00:00:00Z')

  assert.equal(await newestMtime(path.join(dir, 'absent')), 0)
  assert.equal(await newestMtime(path.join(dir, 'top.ts')), new Date('2021-03-01T00:00:00Z').getTime())
})

test('an unchanged tree is answered again without walking it', async () => {
  const dir = await makeTree()
  const first = await countingReaddirs(() => newestMtime(dir))
  assert.equal(first.result, BASE)
  assert.equal(first.readdirs, 3, 'the first check walks the root, a and a/b')

  const second = await countingReaddirs(() => newestMtime(dir))

  assert.equal(second.result, BASE)
  assert.equal(second.readdirs, 0, 'nothing changed, so nothing is walked')
})

test('a change made after a walk finished is seen by the next check', async () => {
  const dir = await makeTree()
  assert.equal(await newestMtime(dir), BASE)

  await touch(path.join(dir, 'a', 'one.ts'), '2023-01-01T00:00:00Z')

  assert.equal(await newestMtime(dir), new Date('2023-01-01T00:00:00Z').getTime())
})

test('a file written deep in the tree is seen by a check made the moment the write returns', async () => {
  const dir = await makeTree()
  assert.equal(await newestMtime(dir), BASE)
  const file = path.join(dir, 'a', 'b', 'two.ts')

  await fs.writeFile(file, 'export const edited = true\n')
  const seen = await newestMtime(dir)

  assert.equal(seen, (await fs.stat(file)).mtimeMs)
  assert.ok(seen > BASE)
})

test('a file added in a new directory is seen', async () => {
  const dir = await makeTree()
  assert.equal(await newestMtime(dir), BASE)

  await fs.mkdir(path.join(dir, 'a', 'c'))
  await fs.writeFile(path.join(dir, 'a', 'c', 'new.ts'), '')
  await touch(path.join(dir, 'a', 'c', 'new.ts'), '2025-01-01T00:00:00Z')
  // The directory entries changed too; set them back so the new file decides.
  for (const entry of ['a/c', 'a']) {
    await touch(path.join(dir, entry), '2020-01-01T00:00:00Z')
  }

  assert.equal(await newestMtime(dir), new Date('2025-01-01T00:00:00Z').getTime())
})

test('deleting the newest file lowers the answer', async () => {
  const dir = await makeTree()
  await touch(path.join(dir, 'a', 'b', 'two.ts'), '2021-06-01T00:00:00Z')
  assert.equal(await newestMtime(dir), new Date('2021-06-01T00:00:00Z').getTime())

  await fs.rm(path.join(dir, 'a', 'b', 'two.ts'))
  await touch(path.join(dir, 'a', 'b'), '2020-01-01T00:00:00Z')

  assert.equal(await newestMtime(dir), BASE)
})

test('a root whose parent is replaced by a rename is walked again, though nothing under the old root changed', async () => {
  // The shape of an install: the new folder is renamed into place over the old
  // one. A watch on the old root's own directories reports nothing for a rename
  // of its parent.
  const live = path.join(await makeTree(), 'ext')
  await fs.mkdir(path.join(live, 'src'), { recursive: true })
  await fs.writeFile(path.join(live, 'src', 'old.ts'), '')
  await touch(path.join(live, 'src', 'old.ts'), '2020-01-01T00:00:00Z')
  await touch(path.join(live, 'src'), '2020-01-01T00:00:00Z')
  const sources = path.join(live, 'src')
  assert.equal(await newestMtime(sources), BASE)

  const incoming = path.join(path.dirname(live), 'ext-incoming')
  await fs.mkdir(path.join(incoming, 'src'), { recursive: true })
  await fs.writeFile(path.join(incoming, 'src', 'new.ts'), '')
  await touch(path.join(incoming, 'src', 'new.ts'), '2026-01-01T00:00:00Z')
  await touch(path.join(incoming, 'src'), '2020-01-01T00:00:00Z')
  await fs.rename(live, path.join(path.dirname(live), 'ext-displaced'))
  await fs.rename(incoming, live)

  assert.equal(await newestMtime(sources), new Date('2026-01-01T00:00:00Z').getTime())
})

test('a change landing during a walk is not kept as the answer', async () => {
  const dir = await makeTree()
  const late = path.join(dir, 'late.ts')
  const realReaddir = fs.readdir
  // Once the walk has listed the root and reached a/b, add a file to the root:
  // too late for this walk's listing of it.
  fs.readdir = (async (...args: Parameters<typeof fs.readdir>) => {
    if (String(args[0]) === path.join(dir, 'a', 'b')) {
      await fs.writeFile(late, '')
      await touch(late, '2027-01-01T00:00:00Z')
    }
    return realReaddir(...args)
  }) as typeof fs.readdir
  try {
    await newestMtime(dir)
  } finally {
    fs.readdir = realReaddir
  }

  assert.equal(await newestMtime(dir), new Date('2027-01-01T00:00:00Z').getTime())
})

test('checks of the same tree that overlap in time share one walk', async () => {
  const dir = await makeTree()

  const { result, readdirs } = await countingReaddirs(() =>
    Promise.all([newestMtime(dir), newestMtime(dir), newestMtime(dir)]),
  )

  assert.equal(readdirs, 3, 'three overlapping checks cost one walk of three directories')
  assert.deepEqual(result, [BASE, BASE, BASE])
})

/** A packages directory with `pkg-a` and `pkg-b`, each a package.json and a src/ file, all at the base time. */
async function makePackages(): Promise<string> {
  seq += 1
  const dir = path.join(root, `packages-${seq}`)
  for (const name of ['pkg-a', 'pkg-b']) {
    await fs.mkdir(path.join(dir, name, 'src', 'deep'), { recursive: true })
    await fs.mkdir(path.join(dir, name, 'node_modules'), { recursive: true })
    await fs.writeFile(path.join(dir, name, 'package.json'), '{}')
    await fs.writeFile(path.join(dir, name, 'src', 'deep', 'index.ts'), '')
    await fs.writeFile(path.join(dir, name, 'README.md'), '')
  }
  const base = new Date('2020-01-01T00:00:00Z')
  for (const name of ['pkg-a', 'pkg-b']) {
    for (const entry of ['package.json', 'src/deep/index.ts', 'src/deep', 'src', 'README.md']) {
      await fs.utimes(path.join(dir, name, entry), base, base)
    }
  }
  return dir
}

test('workspace packages count their package.json and src only, and are not walked again while unchanged', async () => {
  const dir = await makePackages()
  await touch(path.join(dir, 'pkg-b', 'README.md'), '2024-01-01T00:00:00Z')
  const first = await countingReaddirs(() => workspacePackagesMtime(dir))
  assert.equal(first.result, BASE, 'a README is not a source')

  const second = await countingReaddirs(() => workspacePackagesMtime(dir))

  assert.equal(second.result, BASE)
  assert.equal(second.readdirs, 0)
})

test('a workspace package source edit is seen by the next check', async () => {
  const dir = await makePackages()
  assert.equal(await workspacePackagesMtime(dir), BASE)

  await touch(path.join(dir, 'pkg-a', 'src', 'deep', 'index.ts'), '2023-01-01T00:00:00Z')

  assert.equal(await workspacePackagesMtime(dir), new Date('2023-01-01T00:00:00Z').getTime())
})

test('a workspace package.json edit is seen by the next check', async () => {
  const dir = await makePackages()
  assert.equal(await workspacePackagesMtime(dir), BASE)

  await touch(path.join(dir, 'pkg-b', 'package.json'), '2023-02-01T00:00:00Z')

  assert.equal(await workspacePackagesMtime(dir), new Date('2023-02-01T00:00:00Z').getTime())
})

test("a package's src replaced by a rename is seen by the next check", async () => {
  const dir = await makePackages()
  assert.equal(await workspacePackagesMtime(dir), BASE)

  const incoming = path.join(dir, 'pkg-a', 'src-incoming')
  await fs.mkdir(incoming)
  await fs.writeFile(path.join(incoming, 'index.ts'), '')
  await touch(path.join(incoming, 'index.ts'), '2023-03-01T00:00:00Z')
  await touch(incoming, '2020-01-01T00:00:00Z')
  await fs.rm(path.join(dir, 'pkg-a', 'src'), { recursive: true })
  await fs.rename(incoming, path.join(dir, 'pkg-a', 'src'))

  assert.equal(await workspacePackagesMtime(dir), new Date('2023-03-01T00:00:00Z').getTime())
})

test('a root on a network filesystem is walked on every check, since its changes raise no local event', {
  skip: process.platform === 'linux' ? false : 'filesystem types are only read on Linux',
}, async () => {
  const dir = await makeTree()
  const realStatfs = fs.statfs
  fs.statfs = (async (...args: Parameters<typeof fs.statfs>) => ({
    ...(await realStatfs(...args)),
    type: 0x6969,
  })) as typeof fs.statfs
  try {
    const first = await countingReaddirs(() => newestMtime(dir))
    const second = await countingReaddirs(() => newestMtime(dir))

    assert.equal(first.readdirs, 3)
    assert.equal(second.readdirs, 3, 'the second check walks again')
    assert.equal(second.result, BASE)
  } finally {
    fs.statfs = realStatfs
  }
})

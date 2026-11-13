// Real commands through the real local backend, and through docker-exec with a stand-in `docker`,
// against a scratch folder: what is asserted is the bytes and names that land on disk.
import assert from 'node:assert/strict'
import { randomBytes } from 'node:crypto'
import { mkdir, mkdtemp, readdir, readFile, realpath, rm, stat, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'

import type { TerminalContext } from '../types'
import { listTerminalFolders, readTerminalFile, splitExtension, writeTerminalFile } from './files'
import { DOCKER_EXEC, withFakeDocker } from './test-fake-docker'

const LOCAL: TerminalContext = { type: 'local' } as TerminalContext

// Bytes that are not UTF-8, so a channel that decoded them as text would change them.
const BINARY = Buffer.concat([Buffer.from([0xff, 0xfe, 0x00, 0x80, 0xc3]), randomBytes(64 * 1024)])

async function inScratch(fn: (dir: string) => Promise<void>): Promise<void> {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'terminal-files-'))
  try {
    await fn(dir)
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
}

test('a binary file is read back byte for byte', async () => {
  await inScratch(async (dir) => {
    await writeFile(path.join(dir, 'in.bin'), BINARY)
    const read = await readTerminalFile(LOCAL, path.join(dir, 'in.bin'))
    assert.ok(read.equals(BINARY))
  })
})

test('a read past the bound is refused, and one at the bound is not', async () => {
  await inScratch(async (dir) => {
    await writeFile(path.join(dir, 'ten.bin'), Buffer.alloc(10))
    assert.equal((await readTerminalFile(LOCAL, path.join(dir, 'ten.bin'), { maxBytes: 10 })).length, 10)
    await assert.rejects(readTerminalFile(LOCAL, path.join(dir, 'ten.bin'), { maxBytes: 9 }), /larger than 9 bytes/)
  })
})

test('reading a file that is not there names it', async () => {
  await inScratch(async (dir) => {
    await assert.rejects(readTerminalFile(LOCAL, path.join(dir, 'missing.png')), /Could not read .*missing\.png/)
  })
})

test('a write lands byte for byte, creating its folder, and leaves no temp file', async () => {
  await inScratch(async (dir) => {
    const target = path.join(dir, 'a', 'b', 'out.bin')
    assert.deepEqual(await writeTerminalFile(LOCAL, target, BINARY), { path: target })
    assert.ok((await readFile(target)).equals(BINARY))
    assert.deepEqual(await readdir(path.join(dir, 'a', 'b')), ['out.bin'])
  })
})

test('a written file gets the mode the umask gives a new file, not the temp file’s owner-only one', async () => {
  await inScratch(async (dir) => {
    const target = path.join(dir, 'out.bin')
    await writeTerminalFile(LOCAL, target, BINARY)
    const umask = process.umask()
    assert.equal((await stat(target)).mode & 0o777, 0o666 & ~umask)
  })
})

test('overwrite replaces the file at a taken name', async () => {
  await inScratch(async (dir) => {
    const target = path.join(dir, 'out.bin')
    await writeFile(target, 'old')
    await writeTerminalFile(LOCAL, target, BINARY, { ifExists: 'overwrite' })
    assert.ok((await readFile(target)).equals(BINARY))
  })
})

test('fail refuses a taken name and leaves the file and the folder as they were', async () => {
  await inScratch(async (dir) => {
    const target = path.join(dir, 'out.bin')
    await writeFile(target, 'old')
    await assert.rejects(writeTerminalFile(LOCAL, target, BINARY, { ifExists: 'fail' }), /out\.bin already exists/)
    assert.equal(await readFile(target, 'utf8'), 'old')
    assert.deepEqual(await readdir(dir), ['out.bin'])
  })
})

test('number writes the first free numbered name, before the extension', async () => {
  await inScratch(async (dir) => {
    const target = path.join(dir, 'photo.png')
    await writeFile(target, 'first')
    await writeFile(path.join(dir, 'photo-1.png'), 'second')
    const written = await writeTerminalFile(LOCAL, target, BINARY, { ifExists: 'number' })
    assert.equal(written.path, path.join(dir, 'photo-2.png'))
    assert.ok((await readFile(written.path)).equals(BINARY))
    assert.equal(await readFile(target, 'utf8'), 'first')
  })
})

test('number takes the name itself while it is free', async () => {
  await inScratch(async (dir) => {
    const target = path.join(dir, 'photo.png')
    assert.equal((await writeTerminalFile(LOCAL, target, BINARY, { ifExists: 'number' })).path, target)
  })
})

// A folder at the target name, holding one file, so a write that strays into it shows as a second.
async function folderAt(target: string): Promise<void> {
  await mkdir(target)
  await writeFile(path.join(target, 'keep.txt'), 'kept')
}

test('number counts a folder at the name as taken and writes the next numbered name', async () => {
  await inScratch(async (dir) => {
    const target = path.join(dir, 'photo.png')
    await folderAt(target)
    const written = await writeTerminalFile(LOCAL, target, BINARY, { ifExists: 'number' })
    assert.equal(written.path, path.join(dir, 'photo-1.png'))
    assert.ok((await readFile(written.path)).equals(BINARY))
    assert.deepEqual(await readdir(target), ['keep.txt'])
    assert.deepEqual((await readdir(dir)).sort(), ['photo-1.png', 'photo.png'])
  })
})

test('fail refuses a folder at the name and leaves it as it was', async () => {
  await inScratch(async (dir) => {
    const target = path.join(dir, 'photo.png')
    await folderAt(target)
    await assert.rejects(writeTerminalFile(LOCAL, target, BINARY, { ifExists: 'fail' }), /photo\.png already exists/)
    assert.deepEqual(await readdir(target), ['keep.txt'])
    assert.deepEqual(await readdir(dir), ['photo.png'])
  })
})

test('overwrite refuses a folder at the name and leaves it as it was', async () => {
  await inScratch(async (dir) => {
    const target = path.join(dir, 'photo.png')
    await folderAt(target)
    await assert.rejects(writeTerminalFile(LOCAL, target, BINARY, { ifExists: 'overwrite' }), /photo\.png is a folder/)
    assert.deepEqual(await readdir(target), ['keep.txt'])
    assert.deepEqual(await readdir(dir), ['photo.png'])
  })
})

test('names with spaces, quotes and a leading dash are written as given', async () => {
  await inScratch(async (dir) => {
    const target = path.join(dir, `-it's a "file".png`)
    await writeTerminalFile(LOCAL, target, BINARY)
    assert.ok((await readFile(target)).equals(BINARY))
    const again = await writeTerminalFile(LOCAL, target, BINARY, { ifExists: 'number' })
    assert.equal(again.path, path.join(dir, `-it's a "file"-1.png`))
  })
})

test('docker-exec carries the bytes both ways unchanged', async () => {
  await withFakeDocker(async () => {
    await inScratch(async (dir) => {
      const target = path.join(dir, 'out.bin')
      await writeTerminalFile(DOCKER_EXEC, target, BINARY)
      assert.ok((await readFile(target)).equals(BINARY))
      assert.ok((await readTerminalFile(DOCKER_EXEC, target)).equals(BINARY))
    })
  })
})

test('folders are listed by name, dot-folders included and files left out', async () => {
  await inScratch(async (dir) => {
    await mkdir(path.join(dir, 'b'))
    await mkdir(path.join(dir, 'a b'))
    await mkdir(path.join(dir, '.hidden'))
    await writeFile(path.join(dir, 'file.txt'), '')
    const listed = await listTerminalFolders(LOCAL, dir)
    assert.deepEqual(listed.folders, ['.hidden', 'a b', 'b'])
    assert.equal(listed.path, await realpath(dir))
  })
})

test('listing a folder that is not there names it', async () => {
  await inScratch(async (dir) => {
    await assert.rejects(listTerminalFolders(LOCAL, path.join(dir, 'nope')), /Could not list .*nope/)
  })
})

test('an extension is the part after the last dot, and a dotfile has none', () => {
  assert.deepEqual(splitExtension('photo.png'), { stem: 'photo', ext: '.png' })
  assert.deepEqual(splitExtension('archive.tar.gz'), { stem: 'archive.tar', ext: '.gz' })
  assert.deepEqual(splitExtension('.env'), { stem: '.env', ext: '' })
  assert.deepEqual(splitExtension('README'), { stem: 'README', ext: '' })
})

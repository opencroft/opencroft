// Both directions, against a second implementation of the format.
//
// A round trip through fflate alone would be self-consistent and prove
// nothing about whether anyone else can open a backup, so the load-bearing
// assertions here hand the archive to Python's `zipfile` and, in the other
// direction, hand a Python-built archive to the reader this module exposes.
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test, { after } from 'node:test'

import { readZip, readZipMember, writeZip, type ZipMember } from './zip'

const workdir = mkdtempSync(join(tmpdir(), 'opencroft-zip-test-'))

after(() => {
  rmSync(workdir, { recursive: true, force: true })
})

const python = spawnSync('python3', ['-c', 'import zipfile'], { encoding: 'utf8' }).status === 0
const skipWithoutPython = python ? false : 'python3 unavailable'

/**
 * Deterministic bytes deflate cannot shrink.
 *
 * An arithmetic pattern is not enough — `(i * k) % 256` looks scrambled and
 * deflates to 2% of its size, which is how the first version of this fixture
 * managed to assert one branch while exercising another. xorshift32 is
 * reproducible and its output is incompressible.
 */
function pseudoRandom(length: number): Buffer {
  const out = Buffer.alloc(length)
  let state = 0x12345678
  for (let i = 0; i < length; i++) {
    state ^= state << 13
    state ^= state >>> 17
    state ^= state << 5
    out[i] = (state >>> 0) & 0xff
  }
  return out
}

async function collect(archive: string): Promise<ZipMember[]> {
  const members: ZipMember[] = []
  await readZip(archive, (member) => {
    members.push(member)
  })
  return members
}

function python3(script: string, ...args: string[]): { status: number | null; stdout: string; stderr: string } {
  return spawnSync('python3', ['-c', script, ...args], { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 })
}

/** Ask Python what it sees: name, size and CRC per member, after a full integrity check. */
function pythonListing(archive: string): { name: string; size: number }[] {
  const run = python3(
    [
      'import json, sys, zipfile',
      'z = zipfile.ZipFile(sys.argv[1])',
      'bad = z.testzip()',
      'assert bad is None, bad',
      'print(json.dumps([{"name": i.filename, "size": i.file_size} for i in z.infolist()]))',
    ].join('\n'),
    archive,
  )
  assert.equal(run.status, 0, `python3 rejected the archive: ${run.stderr}`)
  return JSON.parse(run.stdout)
}

test('an archive round-trips files, directories and unicode names', async () => {
  const archive = join(workdir, 'round-trip.zip')
  const text = Buffer.from('одна строка\nвторая\n', 'utf8')
  const binary = pseudoRandom(4096)

  await writeZip(archive, [
    { path: 'files/', mtime: new Date('2026-09-22T10:00:00Z') },
    { path: 'files/текст.md', data: text },
    { path: 'files/nested/', mtime: new Date('2026-09-22T10:00:00Z') },
    { path: 'files/nested/bin.dat', data: binary },
    { path: 'empty.txt', data: Buffer.alloc(0) },
  ])

  const members = await collect(archive)
  assert.equal(members.length, 5)
  assert.deepEqual(
    members.map((member) => member.path),
    ['files/', 'files/текст.md', 'files/nested/', 'files/nested/bin.dat', 'empty.txt'],
  )
  assert.deepEqual(members[1].data, text)
  assert.deepEqual(members[3].data, binary)
  assert.equal(members[4].data.length, 0)
  assert.deepEqual(
    members.filter((member) => member.isDirectory).map((member) => member.path),
    ['files/', 'files/nested/'],
  )
})

test('python3 reads the archive this writer produced', { skip: skipWithoutPython }, async () => {
  const archive = join(workdir, 'cross-check.zip')
  const text = Buffer.from('a'.repeat(5000), 'utf8')
  const incompressible = pseudoRandom(8192)
  await writeZip(archive, [
    { path: 'dir/', mtime: new Date('2026-09-22T12:34:56Z') },
    { path: 'dir/compressible.txt', data: text },
    { path: 'dir/random.bin', data: incompressible },
  ])

  const listing = pythonListing(archive)

  assert.deepEqual(
    listing.map((entry) => entry.name),
    ['dir/', 'dir/compressible.txt', 'dir/random.bin'],
  )
  assert.equal(listing[1].size, text.length)
  assert.equal(listing[2].size, incompressible.length)
  // Extraction, not just listing: `testzip()` above walks every member's CRC,
  // and this proves the bytes come back byte-identical through a second
  // implementation of inflate.
  const out = join(workdir, 'extracted')
  const run = python3('import sys, zipfile; zipfile.ZipFile(sys.argv[1]).extractall(sys.argv[2])', archive, out)
  assert.equal(run.status, 0, run.stderr)
  assert.deepEqual(readFileSync(join(out, 'dir', 'compressible.txt')), text)
  assert.deepEqual(readFileSync(join(out, 'dir', 'random.bin')), incompressible)
})

test('this reader reads an archive python3 produced', { skip: skipWithoutPython }, async () => {
  // The other direction, and the one a round trip cannot cover: a backup a
  // person re-zipped with another tool before uploading it. Both compression
  // methods, because a reader that only ever sees its own writer only ever
  // sees one of them.
  const archive = join(workdir, 'python-built.zip')
  const run = python3(
    [
      'import sys, zipfile',
      'z = zipfile.ZipFile(sys.argv[1], "w")',
      'z.writestr("stored.txt", "a" * 3000, zipfile.ZIP_STORED)',
      'z.writestr("deflated.txt", "b" * 3000, zipfile.ZIP_DEFLATED)',
      'z.writestr("dir/", "")',
      'z.writestr("dir/пример.txt", "привет")',
      'z.close()',
    ].join('\n'),
    archive,
  )
  assert.equal(run.status, 0, run.stderr)

  const members = await collect(archive)

  assert.deepEqual(
    members.map((member) => member.path),
    ['stored.txt', 'deflated.txt', 'dir/', 'dir/пример.txt'],
  )
  assert.equal(members[0].data.toString(), 'a'.repeat(3000))
  assert.equal(members[1].data.toString(), 'b'.repeat(3000))
  assert.equal(members[3].data.toString('utf8'), 'привет')
})

test('an incompressible member does not inflate the archive', async () => {
  const archive = join(workdir, 'incompressible.zip')
  const payload = pseudoRandom(256 * 1024)
  await writeZip(archive, [{ path: 'random.bin', data: payload }])
  // Deflate falls back to stored blocks, which cost five bytes per 64KiB
  // block; the headers are the rest. A percent of slack covers both.
  assert.ok(
    statSync(archive).size < payload.length * 1.01 + 512,
    `archive grew past its input: ${statSync(archive).size} vs ${payload.length}`,
  )
})

test('an archive cut short of its central directory is refused', async () => {
  // What this layer can catch on its own. A member of the right length with
  // the WRONG BYTES is not: fflate neither verifies a member's CRC nor exposes
  // it, and `UnzipFile.originalSize` is undefined for everything this writer
  // produces, because fflate's streaming Zip puts the sizes in a trailing data
  // descriptor. That case is caught a layer up, by the archive's SHA-256.
  const archive = join(workdir, 'truncated-member.zip')
  await writeZip(archive, [
    { path: 'payload.bin', data: pseudoRandom(64 * 1024) },
    { path: 'after.txt', data: Buffer.from('still here') },
  ])
  const bytes = readFileSync(archive)
  writeFileSync(archive, bytes.subarray(0, bytes.length - 2048))

  await assert.rejects(() => collect(archive), /Corrupt ZIP archive/)
})

test('a file that is not an archive is refused', async () => {
  const notAZip = join(workdir, 'not-a-zip.bin')
  writeFileSync(notAZip, pseudoRandom(4096))
  await assert.rejects(() => collect(notAZip), /Not a ZIP archive/)
})

test('an empty file is refused rather than read as an empty backup', async () => {
  const empty = join(workdir, 'empty.zip')
  writeFileSync(empty, Buffer.alloc(0))
  await assert.rejects(() => collect(empty), /Not a ZIP archive/)
})

test('one named member can be read without walking the rest', async () => {
  const archive = join(workdir, 'named.zip')
  await writeZip(archive, [
    { path: 'manifest.json', data: Buffer.from('{"formatVersion":2}') },
    { path: 'big.bin', data: pseudoRandom(512 * 1024) },
  ])

  assert.equal((await readZipMember(archive, 'manifest.json'))?.toString(), '{"formatVersion":2}')
  assert.equal(await readZipMember(archive, 'absent.json'), null)
})

test('past 65535 members the archive stays readable', { timeout: 180_000 }, async () => {
  // The 16-bit member count in a plain end-of-central-directory record is the
  // Zip64 threshold a backup can actually reach: app-data is already ~1500
  // entries and agent-workspace is carried whole with nothing filtered out.
  const archive = join(workdir, 'zip64.zip')
  const count = 65_600
  function* members() {
    for (let i = 0; i < count; i++) {
      yield { path: `m/${i}.txt`, data: Buffer.from(String(i), 'utf8') }
    }
  }

  await writeZip(archive, members())

  let seen = 0
  let last = ''
  await readZip(archive, (member) => {
    seen++
    last = member.path
  })
  assert.equal(seen, count, 'the reader lost members past the 16-bit count')
  assert.equal(last, `m/${count - 1}.txt`)
  if (python) {
    const listing = pythonListing(archive)
    assert.equal(listing.length, count)
    assert.equal(listing[count - 1].name, `m/${count - 1}.txt`)
  }
})

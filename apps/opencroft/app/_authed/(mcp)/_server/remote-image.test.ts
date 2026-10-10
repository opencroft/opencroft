// remote_view_image's reading and picture work. The probe and chunk commands
// run in a real bash against real files, because what they print on a missing
// file, a directory or an unreadable one is the shell's behaviour, not ours.
import assert from 'node:assert/strict'
import { execFile } from 'node:child_process'
import { mkdtemp, rm, truncate, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import test from 'node:test'
import { promisify } from 'node:util'

import sharp from 'sharp'

import { VISION_MAX_EDGE, VISION_REENCODE_ABOVE_CHARS } from '@/app/_authed/(agent)/_lib/vision-image'
import {
  buildImageProbeCommand,
  describeView,
  fitWithin,
  MAX_VIEW_FILE_BYTES,
  parseImageProbe,
  parseRegion,
  prepareImage,
  readRemoteBytes,
  sniffImageType,
} from './remote-image'

const run = promisify(execFile)
const quote = (s: string) => `'${s.replace(/'/g, "'\\''")}'`
// A tool refusal is thrown as a plain `{ code, message }` (see tool-refusal.ts), not an Error.
const refusal = (message: RegExp) => ({ message })
const bash = async (command: string) => ({ stdout: (await run('bash', ['-c', command])).stdout, truncated: false })

async function withDir(body: (dir: string) => Promise<void>): Promise<void> {
  const dir = await mkdtemp(path.join(tmpdir(), 'view-image-'))
  try {
    await body(dir)
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
}

const solid = (width: number, height: number, color = { r: 200, g: 40, b: 40 }) =>
  sharp({ create: { width, height, channels: 3, background: color } })

async function probe(filePath: string) {
  return parseImageProbe((await bash(buildImageProbeCommand(filePath, quote))).stdout, filePath)
}

test('the type comes from the bytes, for each of the four kinds and for nothing else', async () => {
  const img = solid(4, 4)
  assert.equal(sniffImageType(await img.clone().png().toBuffer()), 'image/png')
  assert.equal(sniffImageType(await img.clone().jpeg().toBuffer()), 'image/jpeg')
  assert.equal(sniffImageType(await img.clone().webp().toBuffer()), 'image/webp')
  assert.equal(sniffImageType(await img.clone().gif().toBuffer()), 'image/gif')
  assert.equal(sniffImageType(Buffer.from('<html><body>not a picture</body></html>')), null)
  assert.equal(sniffImageType(Buffer.from('<svg xmlns="http://www.w3.org/2000/svg"/>')), null)
})

test('a probed picture reports its size and type, whatever its name says', async () => {
  await withDir(async (dir) => {
    const bytes = await solid(10, 6).png().toBuffer()
    const file = path.join(dir, "a shot's name.jpg")
    await writeFile(file, bytes)
    assert.deepEqual(await probe(file), { size: bytes.length, mimeType: 'image/png' })
  })
})

test('a non-image, a missing file, a directory and an empty file are each refused by name', async () => {
  await withDir(async (dir) => {
    const text = path.join(dir, 'notes.png')
    await writeFile(text, 'just some text that happens to be called .png\n')
    await assert.rejects(probe(text), refusal(/not a PNG, JPEG, WebP or GIF image \(judged by its content/))
    await assert.rejects(probe(path.join(dir, 'nope.png')), refusal(/no such file/))
    await assert.rejects(probe(dir), refusal(/it is a directory/))
    const empty = path.join(dir, 'empty.png')
    await writeFile(empty, '')
    await assert.rejects(probe(empty), refusal(/the file is empty/))
  })
})

test('a file over the read ceiling is refused before any of it is transferred', async () => {
  await withDir(async (dir) => {
    const big = path.join(dir, 'huge.png')
    await writeFile(big, await solid(2, 2).png().toBuffer())
    await truncate(big, MAX_VIEW_FILE_BYTES + 1)
    await assert.rejects(probe(big), refusal(/over the 32\.0 MB a view reads/))
  })
})

test('a file read in several chunks comes back byte for byte', async () => {
  await withDir(async (dir) => {
    const bytes = await sharp({
      create: {
        width: 64,
        height: 64,
        channels: 3,
        background: '#000',
        noise: { type: 'gaussian', mean: 128, sigma: 60 },
      },
    })
      .png()
      .toBuffer()
    const file = path.join(dir, 'noise.png')
    await writeFile(file, bytes)
    const read = await readRemoteBytes(bash, file, bytes.length, quote, 1000)
    assert.ok(bytes.length > 3000, 'the population spans several chunks')
    assert.ok(read.equals(bytes))
  })
})

test('a chunk the backend cut, or one that came back short, refuses the whole read', async () => {
  await withDir(async (dir) => {
    const bytes = await solid(30, 30).png().toBuffer()
    const file = path.join(dir, 'p.png')
    await writeFile(file, bytes)
    const cut = async (command: string) => ({ ...(await bash(command)), truncated: true })
    await assert.rejects(readRemoteBytes(cut, file, bytes.length, quote), refusal(/Refusing to view a partial file/))
    // The file shrank after the probe: the last chunk is short.
    await assert.rejects(
      readRemoteBytes(bash, file, bytes.length + 10, quote),
      refusal(/expected \d+ bytes at offset 0, received \d+\. Refusing to view a partial file/),
    )
  })
})

test('a region must be whole, non-negative numbers with a size', () => {
  assert.equal(parseRegion(undefined), undefined)
  assert.deepEqual(parseRegion({ x: 0, y: 5, width: 10, height: 1 }), { x: 0, y: 5, width: 10, height: 1 })
  assert.throws(() => parseRegion({ x: -1, y: 0, width: 1, height: 1 }), refusal(/region\.x/))
  assert.throws(() => parseRegion({ x: 0, y: 0, width: 0, height: 1 }), refusal(/region\.width/))
  assert.throws(() => parseRegion({ x: 0, y: 0, width: 1.5, height: 1 }), refusal(/region\.width/))
  assert.throws(() => parseRegion('0,0,1,1'), refusal(/region must be an object/))
})

test('fitting keeps the aspect ratio and puts the long edge at the limit', () => {
  assert.deepEqual(fitWithin(3000, 2000), { width: VISION_MAX_EDGE, height: 1045 })
  assert.deepEqual(fitWithin(1000, 4000), { width: 392, height: VISION_MAX_EDGE })
  assert.deepEqual(fitWithin(800, 600), { width: 800, height: 600 })
})

test('a picture within every limit is sent exactly as read', async () => {
  const bytes = await solid(800, 600).png().toBuffer()
  const image = await prepareImage(bytes, 'image/png', '/x/a.png')
  assert.equal(image.reencoded, false)
  assert.ok(image.data.equals(bytes))
  assert.match(
    describeView('/x/a.png', image),
    /^\/x\/a\.png: PNG, 800×600, .*\nSent: PNG, 800×600, .*, the file as it is\.$/,
  )
})

test('an oversized picture is scaled down, and the text says from what to what', async () => {
  const bytes = await solid(3000, 2000).png().toBuffer()
  const image = await prepareImage(bytes, 'image/png', '/x/big.png')
  const sent = await sharp(image.data).metadata()
  assert.deepEqual([sent.width, sent.height], [VISION_MAX_EDGE, 1045])
  assert.equal(image.mimeType, 'image/png')
  assert.match(describeView('/x/big.png', image), /scaled down from 3000×2000 to keep the long edge within 1568 px/)
})

test('a region is cut from the source at full resolution, before any scaling', async () => {
  // Left half red, right half blue: a crop of the right half must be all blue.
  const half = 1000
  const bytes = await sharp({ create: { width: half * 2, height: 800, channels: 3, background: '#ff0000' } })
    .composite([{ input: await solid(half, 800, { r: 0, g: 0, b: 255 }).png().toBuffer(), left: half, top: 0 }])
    .png()
    .toBuffer()
  const image = await prepareImage(bytes, 'image/png', '/x/split.png', { x: 1200, y: 100, width: 300, height: 200 })
  const { data, info } = await sharp(image.data).raw().toBuffer({ resolveWithObject: true })
  assert.deepEqual([info.width, info.height], [300, 200], 'not scaled: the region is under the limit')
  assert.deepEqual([...data.subarray(0, 3)], [0, 0, 255])
  assert.match(
    describeView('/x/split.png', image),
    /Region: x=1200, y=100, 300×200\.\nSent: PNG, 300×200, .*re-encoded at full resolution/,
  )
})

test('a region reaching outside the picture is refused with the picture size', async () => {
  const bytes = await solid(100, 50).png().toBuffer()
  await assert.rejects(
    prepareImage(bytes, 'image/png', '/x/s.png', { x: 90, y: 0, width: 20, height: 10 }),
    refusal(/reaches outside the 100×50 picture/),
  )
})

test('bytes that start like a picture but do not decode are refused, not sent', async () => {
  const fake = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.alloc(64, 7)])
  await assert.rejects(prepareImage(fake, 'image/png', '/x/fake.png'), refusal(/could not be decoded as image\/png/))
})

test('a picture over the size budget at full resolution is re-encoded under it', async () => {
  const bytes = await sharp({
    create: {
      width: 1500,
      height: 1000,
      channels: 3,
      background: '#000',
      noise: { type: 'gaussian', mean: 128, sigma: 80 },
    },
  })
    .png()
    .toBuffer()
  assert.ok(Math.ceil(bytes.length / 3) * 4 > VISION_REENCODE_ABOVE_CHARS, 'the control is over the budget')
  const image = await prepareImage(bytes, 'image/png', '/x/noise.png')
  assert.equal(image.reencoded, true)
  assert.equal(image.mimeType, 'image/webp')
  assert.ok(Math.ceil(image.data.length / 3) * 4 <= VISION_REENCODE_ABOVE_CHARS)
  const sent = await sharp(image.data).metadata()
  assert.deepEqual([sent.width, sent.height], [1500, 1000])
})

test('a GIF that has to be re-encoded goes as a PNG of its picture', async () => {
  const bytes = await solid(2000, 100).gif().toBuffer()
  const image = await prepareImage(bytes, 'image/gif', '/x/wide.gif')
  assert.equal(image.mimeType, 'image/png')
  assert.equal((await sharp(image.data).metadata()).width, VISION_MAX_EDGE)
})

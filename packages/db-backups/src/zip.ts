import { once } from 'node:events'
import { createReadStream, createWriteStream } from 'node:fs'
import fs from 'node:fs/promises'

import { Unzip, UnzipInflate, Zip, ZipDeflate, ZipPassThrough } from 'fflate'

// The ZIP container a backup archive is packed into, over fflate.
//
// BOTH DIRECTIONS STREAM. fflate's `zipSync`/`unzipSync` are one call each,
// but they hold the whole archive in memory, and one of the roots a backup
// carries — `agent-workspace` — is taken whole and has no bound on it. The
// streaming classes cost this file instead: memory here is one member at a
// time, not one archive.

export interface ZipEntryInput {
  /** Path inside the archive, '/'-separated. A trailing '/' marks a directory. */
  path: string
  /** Contents. Omitted or empty for a directory. */
  data?: Buffer
  mtime?: Date
  /** Unix mode, recorded so a member unzipped by hand keeps its permissions. */
  mode?: number
}

export interface ZipEntryInfo {
  path: string
  isDirectory: boolean
  sizeBytes: number
}

export interface ZipMember {
  path: string
  isDirectory: boolean
  data: Buffer
}

/**
 * Called once per member, in archive order.
 *
 * Returning exactly `false` stops the read. The return type is `unknown`
 * rather than `boolean | void` so that a handler which returns nothing still
 * satisfies it — `void` in a union is its own kind of confusing, and the only
 * value this contract reads is `false`.
 */
export type ZipMemberHandler = (member: ZipMember) => unknown

/**
 * Write `entries` to `destPath` as a ZIP archive, in the order given.
 *
 * Every member is deflated. The store-when-it-does-not-help optimisation is
 * deliberately absent: deflate emits stored blocks for input it cannot improve
 * on, so an incompressible member costs five bytes per 64 KiB rather than a
 * second pass over the data to find that out.
 */
export async function writeZip(
  destPath: string,
  entries: AsyncIterable<ZipEntryInput> | Iterable<ZipEntryInput>,
): Promise<ZipEntryInfo[]> {
  const out = createWriteStream(destPath)
  const written: ZipEntryInfo[] = []
  let failure: Error | undefined

  const zip = new Zip((err, chunk, final) => {
    if (err) {
      failure ??= err
      return
    }
    // fflate's callback is synchronous and has nowhere to wait, so a full
    // write queue is handled by the producer instead: this queues the chunk
    // and the loop below drains before it hands over the next member.
    out.write(chunk)
    if (final) {
      out.end()
    }
  })

  const drain = async () => {
    if (out.writableNeedDrain) {
      await once(out, 'drain')
    }
    if (failure) {
      throw failure
    }
  }

  try {
    for await (const entry of entries as AsyncIterable<ZipEntryInput>) {
      const isDirectory = entry.path.endsWith('/')
      const data = isDirectory ? Buffer.alloc(0) : (entry.data ?? Buffer.alloc(0))
      // A directory has no contents to compress, and a passthrough member is
      // what every reader expects to find under a name ending in '/'.
      const member = isDirectory ? new ZipPassThrough(entry.path) : new ZipDeflate(entry.path, { level: 6 })
      member.mtime = entry.mtime
      // os 3 is Unix, which is what makes the mode in the high bits of `attrs`
      // mean anything to a tool unpacking this by hand; the low bits carry the
      // MS-DOS directory flag for the tools that read that instead of the
      // trailing slash. fflate writes the field byte by byte, so a value past
      // 2^31 is safe here.
      member.os = 3
      const mode = entry.mode ?? (isDirectory ? 0o755 : 0o644)
      member.attrs = (((mode << 16) >>> 0) | (isDirectory ? 0x10 : 0)) >>> 0
      zip.add(member)
      member.push(data, true)
      written.push({ path: entry.path, isDirectory, sizeBytes: data.length })
      await drain()
    }
    zip.end()
  } catch (err) {
    out.destroy()
    throw err
  }
  await once(out, 'close')
  if (failure) {
    throw failure
  }
  return written
}

/** The three signatures a ZIP file can legally start with: a member, an empty archive, a spanned one. */
const ZIP_MAGICS = ['PK\u0003\u0004', 'PK\u0005\u0006', 'PK\u0007\u0008']

/** `PK\x05\x06` — the end-of-central-directory record every complete archive ends with. */
const EOCD_SIGNATURE = Buffer.from('PK\u0005\u0006', 'latin1')

/** The record is 22 bytes and can be pushed back by a comment of up to 64KiB. */
const EOCD_SEARCH_WINDOW = 0xffff + 22

/**
 * Refuse, before reading a byte of content, a file that is not a whole archive.
 *
 * Both halves exist because fflate's streaming reader answers neither
 * question, measured 2026-09-22. Handed a file that is not an archive it
 * reports nothing and yields no members, so a mis-picked file would "restore"
 * as an empty backup. And it works from the LOCAL header in front of each
 * member, never consulting the central directory, so an archive whose tail was
 * lost in transit streams its members out and looks fine — while every other
 * tool needs that directory to open the file at all, which makes a backup
 * without one unopenable on the day it is needed.
 *
 * The two messages are the distinction a person acting on them needs: wrong
 * file, or right file damaged. Neither check reads a field out of the format;
 * both look for a signature, and the parsing stays fflate's.
 */
async function assertWholeArchive(srcPath: string): Promise<void> {
  const handle = await fs.open(srcPath, 'r')
  try {
    const { size } = await handle.stat()
    if (size === 0) {
      throw new Error('Not a ZIP archive: the file is empty')
    }
    const head = Buffer.alloc(4)
    await handle.read(head, 0, 4, 0)
    if (!ZIP_MAGICS.includes(head.toString('latin1'))) {
      throw new Error('Not a ZIP archive: the file does not start with a ZIP signature')
    }
    const length = Math.min(size, EOCD_SEARCH_WINDOW)
    const tail = Buffer.alloc(length)
    await handle.read(tail, 0, length, size - length)
    if (!tail.includes(EOCD_SIGNATURE)) {
      throw new Error('Corrupt ZIP archive: the central directory is missing, so the file was truncated')
    }
  } finally {
    await handle.close()
  }
}

/**
 * Stream an archive's members in the order they were written.
 *
 * `onMember` returning false stops the read, which is what lets a caller that
 * only wants the manifest — written first, on purpose — pay for one member
 * rather than for the whole archive.
 *
 * The file is checked for being a whole archive before any of it is read (see
 * `assertWholeArchive`). What remains uncovered is a member of the right
 * length whose bytes are wrong: fflate neither verifies a member's CRC nor
 * exposes it, so that one is caught a layer up, by the SHA-256 `archive.ts`
 * carries over everything it wrote.
 */
export async function readZip(srcPath: string, onMember: ZipMemberHandler): Promise<void> {
  await assertWholeArchive(srcPath)
  const unzip = new Unzip()
  unzip.register(UnzipInflate)

  // Members complete inside a `push`, so this queue holds only what one chunk
  // finished — the bound on memory is the largest single member, not the
  // archive.
  const completed: ZipMember[] = []
  let failure: Error | undefined

  unzip.onfile = (file) => {
    const chunks: Uint8Array[] = []
    file.ondata = (err, chunk, final) => {
      if (err) {
        failure ??= err
        return
      }
      if (chunk.length > 0) {
        chunks.push(chunk)
      }
      if (final) {
        const data = Buffer.concat(chunks)
        // Absent for archives written in a streaming fashion, which is why
        // this is a comparison and not an assertion of presence.
        if (typeof file.originalSize === 'number' && data.length !== file.originalSize) {
          failure ??= new Error(
            `Corrupt ZIP archive: ${file.name} is ${data.length} bytes, the archive says ${file.originalSize}`,
          )
          return
        }
        completed.push({ path: file.name, isDirectory: file.name.endsWith('/'), data })
      }
    }
    file.start()
  }

  const stream = createReadStream(srcPath)
  try {
    for await (const chunk of stream) {
      unzip.push(new Uint8Array(chunk as Buffer), false)
      if (failure) {
        throw failure
      }
      while (completed.length > 0) {
        const member = completed.shift() as ZipMember
        if ((await onMember(member)) === false) {
          return
        }
      }
    }
    unzip.push(new Uint8Array(0), true)
    if (failure) {
      throw failure
    }
    while (completed.length > 0) {
      const member = completed.shift() as ZipMember
      if ((await onMember(member)) === false) {
        return
      }
    }
  } catch (err) {
    // fflate reports a file that is not an archive through its error callback
    // or by throwing out of push(); either way the caller gets one message.
    throw asArchiveError(err)
  } finally {
    // Idempotent, and the point is the early-return path: a handler that
    // stopped the read leaves the stream mid-file with more to deliver.
    stream.destroy()
  }
}

/**
 * Give fflate's failures the vocabulary the rest of this package uses.
 *
 * The distinction is the one a person acting on the message needs: "not an
 * archive" means they picked the wrong file, "corrupt" means the right file
 * arrived damaged. fflate says `invalid zip data` for both, and this layer has
 * already refused the first case by signature before it can get here.
 */
function asArchiveError(err: unknown): Error {
  const message = err instanceof Error ? err.message : String(err)
  if (/^Not a ZIP archive|^Corrupt ZIP archive/.test(message)) {
    return err instanceof Error ? err : new Error(message)
  }
  if (/invalid zip|unexpected EOF|invalid signature/i.test(message)) {
    return new Error(`Corrupt ZIP archive: ${message}`)
  }
  return err instanceof Error ? err : new Error(message)
}

/** Read one named member, stopping as soon as it is found. Null if the archive has no such member. */
export async function readZipMember(srcPath: string, path: string): Promise<Buffer | null> {
  let found: Buffer | null = null
  await readZip(srcPath, (member) => {
    if (member.path !== path) {
      return
    }
    found = member.data
    return false
  })
  return found
}

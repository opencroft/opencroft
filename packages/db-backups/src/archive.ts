import { createHash } from 'node:crypto'
import fs from 'node:fs/promises'
import path from 'node:path'

import { type Backup, excludedTableNames } from '@opencroft/db/backup'

import { BACKUP_FILE_ROOTS, type FileRoot, type SkippedEntry, walkRoot } from './file-tree'
import { readZip, readZipMember, writeZip, type ZipEntryInput, type ZipMember } from './zip'

// The backup archive: one ZIP holding the logical database dump and the parts
// of the data directory nothing else holds a copy of.
//
//   manifest.json     what is inside, written FIRST so a listing or an upload
//                     check reads one member instead of the whole archive
//   database.json     the `Backup` object, the same shape a v1 .json file was
//   files/<root>/...  the data directory, one subtree per root
//   checksums.json    written LAST, because it covers everything before it
//
// A RESTORE VERIFIES BEFORE IT APPLIES. `checksums.json` carries one SHA-256
// over every preceding member — path, length and bytes, in order — so a
// truncated, reordered or damaged archive is refused whole rather than half
// applied. The container's own CRCs would have said the same thing, but fflate
// neither checks them nor hands them out (measured 2026-09-22), and a digest
// in the format survives an archive being unpacked and rezipped by something
// else, which a CRC in the container does not.

export const ARCHIVE_FORMAT_VERSION = 2

export const MANIFEST_MEMBER = 'manifest.json'
export const DATABASE_MEMBER = 'database.json'
export const TRAILER_MEMBER = 'checksums.json'
export const FILES_PREFIX = 'files/'

export interface ArchiveFileStats {
  files: number
  directories: number
  bytes: number
}

export interface ArchiveManifest {
  formatVersion: number
  createdAt: string
  database: {
    /** SQL table name -> row count, for every table the dump carries. */
    tables: Record<string, number>
    totalRows: number
    /** Tables deliberately not carried, so a reader is not left guessing. */
    excludedTables: string[]
  }
  /** Data-directory roots this archive holds, in `files/` under these names. */
  fileRoots: string[]
}

export interface ArchiveTrailer {
  algorithm: 'sha256'
  digest: string
  /** How many members the digest covers — this one excluded. */
  members: number
  files: Record<string, ArchiveFileStats>
  skipped: (SkippedEntry & { root: string })[]
  /**
   * Members that were executable, by archive path.
   *
   * The ZIP itself carries the Unix mode, and a person unpacking the archive
   * by hand gets it — but fflate's streaming reader does not expose the
   * attribute field, so a restore through THIS code would hand every file back
   * at the default mode. `agent-workspace` is taken whole precisely because
   * anything can be in it, and a script that comes back without its +x has not
   * been restored.
   */
  executables: string[]
}

export interface BackupArchive {
  manifest: ArchiveManifest
  trailer: ArchiveTrailer
  backup: Backup
}

/**
 * Fold one member into the running digest.
 *
 * The length goes in as well as the bytes, so two members cannot be confused
 * for one longer one, and the path goes in so a member cannot be renamed or
 * reordered without the digest moving.
 */
function foldMember(hash: ReturnType<typeof createHash>, memberPath: string, data: Buffer): void {
  const header = Buffer.alloc(8)
  header.writeBigUInt64LE(BigInt(data.length))
  hash.update(memberPath, 'utf8')
  hash.update('\0')
  hash.update(header)
  hash.update(data)
}

/**
 * Serialise a `Backup` without building one giant string first.
 *
 * `JSON.stringify` over the whole object holds the entire dump as a UTF-16
 * string AND as a buffer at once. Per table, each table's string is released
 * before the next is built, so the peak is the total plus the largest table
 * rather than twice the total. The rows themselves are already in memory —
 * that is `createBackup`'s bound, not this one's.
 */
function serialiseBackup(backup: Backup): Buffer {
  const chunks: Buffer[] = [
    Buffer.from(
      `{"formatVersion":${JSON.stringify(backup.formatVersion)},"createdAt":${JSON.stringify(backup.createdAt)},"tables":{`,
      'utf8',
    ),
  ]
  const names = Object.keys(backup.tables)
  names.forEach((name, index) => {
    chunks.push(
      Buffer.from(`${index > 0 ? ',' : ''}${JSON.stringify(name)}:${JSON.stringify(backup.tables[name])}`, 'utf8'),
    )
  })
  chunks.push(Buffer.from('}}', 'utf8'))
  return Buffer.concat(chunks)
}

export interface WriteArchiveOptions {
  backup: Backup
  /** Absolute path of the data directory the file roots live under. */
  dataDirectory: string
  roots?: readonly FileRoot[]
}

/** Write a backup archive to `destPath`. Returns what its manifest and trailer ended up saying. */
export async function writeBackupArchive(
  destPath: string,
  { backup, dataDirectory, roots = BACKUP_FILE_ROOTS }: WriteArchiveOptions,
): Promise<{ manifest: ArchiveManifest; trailer: ArchiveTrailer }> {
  const tables: Record<string, number> = {}
  let totalRows = 0
  for (const [name, rows] of Object.entries(backup.tables)) {
    tables[name] = rows.length
    totalRows += rows.length
  }
  const manifest: ArchiveManifest = {
    formatVersion: ARCHIVE_FORMAT_VERSION,
    createdAt: backup.createdAt,
    database: { tables, totalRows, excludedTables: excludedTableNames() },
    fileRoots: roots.map((root) => root.name),
  }

  const hash = createHash('sha256')
  const stats: Record<string, ArchiveFileStats> = {}
  const skipped: (SkippedEntry & { root: string })[] = []
  const executables: string[] = []
  let members = 0

  async function* entries(): AsyncGenerator<ZipEntryInput> {
    const manifestData = Buffer.from(JSON.stringify(manifest, null, 2), 'utf8')
    foldMember(hash, MANIFEST_MEMBER, manifestData)
    members++
    yield { path: MANIFEST_MEMBER, data: manifestData, mtime: new Date(backup.createdAt) }

    const databaseData = serialiseBackup(backup)
    foldMember(hash, DATABASE_MEMBER, databaseData)
    members++
    yield { path: DATABASE_MEMBER, data: databaseData, mtime: new Date(backup.createdAt) }

    for (const root of roots) {
      const rootStats: ArchiveFileStats = { files: 0, directories: 0, bytes: 0 }
      stats[root.name] = rootStats
      const rootSkipped: SkippedEntry[] = []
      for await (const entry of walkRoot(dataDirectory, root, rootSkipped)) {
        const memberPath = `${FILES_PREFIX}${root.name}/${entry.relativePath}`
        if (entry.isDirectory) {
          rootStats.directories++
          foldMember(hash, memberPath, Buffer.alloc(0))
          members++
          yield { path: memberPath, mtime: entry.mtime, mode: entry.mode }
          continue
        }
        let data: Buffer
        try {
          data = await fs.readFile(entry.absolutePath)
        } catch (err) {
          rootSkipped.push({ path: entry.relativePath, reason: `unreadable: ${(err as Error).message}` })
          continue
        }
        rootStats.files++
        rootStats.bytes += data.length
        if ((entry.mode & 0o111) !== 0) {
          executables.push(memberPath)
        }
        foldMember(hash, memberPath, data)
        members++
        yield { path: memberPath, data, mtime: entry.mtime, mode: entry.mode }
      }
      skipped.push(...rootSkipped.map((entry) => ({ ...entry, root: root.name })))
    }

    const trailer: ArchiveTrailer = {
      algorithm: 'sha256',
      digest: hash.digest('hex'),
      members,
      files: stats,
      skipped,
      executables,
    }
    yield { path: TRAILER_MEMBER, data: Buffer.from(JSON.stringify(trailer, null, 2), 'utf8'), mtime: new Date() }
  }

  await writeZip(destPath, entries())
  // Read back rather than reconstruct: the generator above finished after the
  // caller's last look at these, and the file is the only place the final
  // numbers exist.
  const trailerData = await readZipMember(destPath, TRAILER_MEMBER)
  if (!trailerData) {
    throw new Error('Backup archive was written without its checksum trailer')
  }
  return { manifest, trailer: JSON.parse(trailerData.toString('utf8')) as ArchiveTrailer }
}

function parseJson<T>(data: Buffer, member: string): T {
  try {
    return JSON.parse(data.toString('utf8')) as T
  } catch (err) {
    throw new Error(`Backup archive has an unreadable ${member}: ${(err as Error).message}`)
  }
}

/**
 * Read an archive's manifest alone.
 *
 * The manifest is the first member, so this stops after one — what an upload
 * check and a confirmation dialog need, without inflating the rest.
 */
export async function readArchiveManifest(srcPath: string): Promise<ArchiveManifest> {
  const data = await readZipMember(srcPath, MANIFEST_MEMBER)
  if (!data) {
    throw new Error('Not a backup archive: no manifest.json')
  }
  return parseJson<ArchiveManifest>(data, MANIFEST_MEMBER)
}

/**
 * Read an archive and verify it end to end. Touches nothing on disk.
 *
 * The first half of a restore: if this returns, the archive is intact and the
 * caller can apply it. If it throws, nothing has been changed.
 */
export async function readBackupArchive(srcPath: string): Promise<BackupArchive> {
  const hash = createHash('sha256')
  let manifest: ArchiveManifest | undefined
  let backup: Backup | undefined
  let trailer: ArchiveTrailer | undefined
  let members = 0

  await readZip(srcPath, (member: ZipMember) => {
    if (member.path === TRAILER_MEMBER) {
      trailer = parseJson<ArchiveTrailer>(member.data, TRAILER_MEMBER)
      return
    }
    foldMember(hash, member.path, member.data)
    members++
    if (member.path === MANIFEST_MEMBER) {
      manifest = parseJson<ArchiveManifest>(member.data, MANIFEST_MEMBER)
    } else if (member.path === DATABASE_MEMBER) {
      backup = parseJson<Backup>(member.data, DATABASE_MEMBER)
    }
  })

  if (!manifest) {
    throw new Error('Not a backup archive: no manifest.json')
  }
  if (!backup) {
    throw new Error('Backup archive has no database.json')
  }
  if (!trailer) {
    throw new Error('Backup archive is incomplete: no checksums.json. It was probably truncated in transit.')
  }
  if (trailer.members !== members) {
    throw new Error(`Backup archive is incomplete: ${members} members present, ${trailer.members} expected`)
  }
  const digest = hash.digest('hex')
  if (digest !== trailer.digest) {
    throw new Error('Backup archive fails its checksum: its contents are not what it was written with')
  }
  return { manifest, trailer, backup }
}

/**
 * Where a `files/` member lands, or null if it is not one.
 *
 * Refuses anything that would leave the root it names: an uploaded archive is
 * a file a person chose, not one this system wrote, and `files/../../etc` in a
 * member name is the oldest trick against an extractor.
 */
function resolveFileMember(memberPath: string, dataDirectory: string, roots: readonly string[]): string | null {
  if (!memberPath.startsWith(FILES_PREFIX)) {
    return null
  }
  const relative = memberPath.slice(FILES_PREFIX.length)
  const root = roots.find((name) => relative === name || relative.startsWith(`${name}/`))
  if (!root) {
    throw new Error(`Backup archive names a root it did not declare: ${memberPath}`)
  }
  const rootDirectory = path.resolve(dataDirectory, ...root.split('/'))
  const target = path.resolve(rootDirectory, relative.slice(root.length + 1))
  if (target !== rootDirectory && !target.startsWith(rootDirectory + path.sep)) {
    throw new Error(`Backup archive member escapes its root: ${memberPath}`)
  }
  return target
}

export interface ExtractResult {
  /** Roots that were cleared and refilled. */
  roots: string[]
  files: number
  directories: number
}

/**
 * Write the file half of an archive onto disk, replacing each declared root.
 *
 * REPLACEMENT, not merge: a restored root ends up as exactly what the archive
 * holds, which is what makes a restore reproduce a state rather than blend two
 * of them. Only the roots the manifest declares are touched; anything else in
 * the data directory — the database, the backups themselves — is left alone.
 *
 * Call `readBackupArchive` first. This does not verify; it applies.
 */
export async function extractBackupFiles(
  srcPath: string,
  dataDirectory: string,
  manifest: ArchiveManifest,
  trailer?: ArchiveTrailer,
): Promise<ExtractResult> {
  const roots = manifest.fileRoots
  for (const root of roots) {
    const rootDirectory = path.resolve(dataDirectory, ...root.split('/'))
    await fs.rm(rootDirectory, { recursive: true, force: true })
    await fs.mkdir(rootDirectory, { recursive: true })
  }
  const executables = new Set(trailer?.executables ?? [])
  const result: ExtractResult = { roots: [...roots], files: 0, directories: 0 }
  await readZip(srcPath, async (member) => {
    const target = resolveFileMember(member.path, dataDirectory, roots)
    if (!target) {
      return
    }
    if (member.isDirectory) {
      await fs.mkdir(target, { recursive: true })
      result.directories++
      return
    }
    await fs.mkdir(path.dirname(target), { recursive: true })
    await fs.writeFile(target, member.data)
    if (executables.has(member.path)) {
      await fs.chmod(target, 0o755)
    }
    result.files++
  })
  return result
}

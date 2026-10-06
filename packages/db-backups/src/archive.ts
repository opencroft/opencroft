import { createHash } from 'node:crypto'
import fs from 'node:fs/promises'
import path from 'node:path'

import { type Backup, type BackupSource, backupSource, excludedTableNames } from '@opencroft/db/backup'

import {
  type DumpMember,
  databaseMemberTable,
  type StagedDump,
  stageDumpMember,
  stagedDumpSource,
} from './database-dump'
import { BACKUP_FILE_ROOTS, type FileRoot, type SkippedEntry, walkRoot } from './file-tree'
import { readZip, readZipMember, writeZip, type ZipEntryInput, type ZipMember } from './zip'

// The backup archive: one ZIP holding the logical database dump and the parts
// of the data directory nothing else holds a copy of.
//
//   manifest.json       what is inside, written FIRST so a listing or an upload
//                       check reads one member instead of the whole archive
//   database/<table>/   the rows, as bounded JSON Lines members (database-dump.ts)
//   files/<root>/...    the data directory, one subtree per root
//   checksums.json      written LAST, because it covers everything before it
//
// Format 2 carried the rows as one `database.json`, the `Backup` object a v1
// .json file was. Such an archive still restores; none is written, because one
// serialised dump is one string, and V8 caps a string at about 512 MiB.
//
// A RESTORE VERIFIES BEFORE IT APPLIES. `checksums.json` carries one SHA-256
// over every preceding member — path, length and bytes, in order — so a
// truncated, reordered or damaged archive is refused whole rather than half
// applied. The container's own CRCs would have said the same thing, but fflate
// neither checks them nor hands them out (measured 2026-09-22), and a digest
// in the format survives an archive being unpacked and rezipped by something
// else, which a CRC in the container does not.

export const ARCHIVE_FORMAT_VERSION = 3

export const MANIFEST_MEMBER = 'manifest.json'
/** Format 2's whole-dump member. Read, never written. */
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
  database: BackupSource
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
 * Row counts per table, for a manifest or for a caller describing a file.
 *
 * Shared because the `.zip` path and the legacy `.json` path both report this
 * same pair to the same dialog, and two copies of the fold could answer
 * differently.
 */
export function summariseTables(backup: Backup): { tables: Record<string, number>; totalRows: number } {
  const tables: Record<string, number> = {}
  let totalRows = 0
  for (const [name, rows] of Object.entries(backup.tables)) {
    tables[name] = rows.length
    totalRows += rows.length
  }
  return { tables, totalRows }
}

export interface WriteArchiveOptions {
  /** ISO time the backup was taken. */
  createdAt: string
  /** The rows, already staged by `stageDatabaseDump`. */
  database: StagedDump
  /** Absolute path of the data directory the file roots live under. */
  dataDirectory: string
  roots?: readonly FileRoot[]
}

/** Write a backup archive to `destPath`. Returns what its manifest and trailer ended up saying. */
export async function writeBackupArchive(
  destPath: string,
  { createdAt, database, dataDirectory, roots = BACKUP_FILE_ROOTS }: WriteArchiveOptions,
): Promise<{ manifest: ArchiveManifest; trailer: ArchiveTrailer }> {
  const manifest: ArchiveManifest = {
    formatVersion: ARCHIVE_FORMAT_VERSION,
    createdAt,
    database: {
      tables: database.tables,
      totalRows: Object.values(database.tables).reduce((sum, rows) => sum + rows, 0),
      excludedTables: excludedTableNames(),
    },
    fileRoots: roots.map((root) => root.name),
  }

  const hash = createHash('sha256')
  const stats: Record<string, ArchiveFileStats> = {}
  const skipped: (SkippedEntry & { root: string })[] = []
  const executables: string[] = []
  let members = 0
  let trailer: ArchiveTrailer | undefined

  async function* entries(): AsyncGenerator<ZipEntryInput> {
    const manifestData = Buffer.from(JSON.stringify(manifest, null, 2), 'utf8')
    foldMember(hash, MANIFEST_MEMBER, manifestData)
    members++
    yield { path: MANIFEST_MEMBER, data: manifestData, mtime: new Date(createdAt) }

    for (const member of database.members) {
      const data = await fs.readFile(member.file)
      foldMember(hash, member.path, data)
      members++
      yield { path: member.path, data, mtime: new Date(createdAt) }
    }

    for (const root of roots) {
      const rootStats: ArchiveFileStats = { files: 0, directories: 0, bytes: 0 }
      stats[root.name] = rootStats
      const rootSkipped: SkippedEntry[] = []
      const noteSkipped = (path: string, reason: string) => skipped.push({ root: root.name, path, reason })
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
          noteSkipped(entry.relativePath, `unreadable: ${(err as Error).message}`)
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
      for (const entry of rootSkipped) {
        noteSkipped(entry.path, entry.reason)
      }
    }

    trailer = {
      algorithm: 'sha256',
      digest: hash.digest('hex'),
      members,
      files: stats,
      skipped,
      executables,
    }
    yield { path: TRAILER_MEMBER, data: Buffer.from(JSON.stringify(trailer, null, 2), 'utf8'), mtime: new Date() }
  }

  // `writeZip` drains the generator to completion before it resolves, so the
  // trailer it built is in hand. Reading it back out of the finished file
  // would mean inflating every member to reach the last one — measured at a
  // sixth of the whole backup, for a value that never left this scope.
  await writeZip(destPath, entries())
  if (!trailer) {
    throw new Error('Backup archive was written without its checksum trailer')
  }
  return { manifest, trailer }
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
 * Read an archive and verify it end to end, staging its rows in
 * `stagingDirectory`. Touches nothing else on disk.
 *
 * The first half of a restore: if this returns, the archive is intact and the
 * caller can apply it. If it throws, nothing has been changed. The returned
 * `database` reads from `stagingDirectory`, so that must outlive its use.
 */
export async function readBackupArchive(srcPath: string, stagingDirectory: string): Promise<BackupArchive> {
  const hash = createHash('sha256')
  let manifest: ArchiveManifest | undefined
  let legacyDump: Backup | undefined
  let trailer: ArchiveTrailer | undefined
  const dumpMembers: DumpMember[] = []
  let members = 0

  await fs.mkdir(stagingDirectory, { recursive: true })
  await readZip(srcPath, async (member: ZipMember) => {
    if (member.path === TRAILER_MEMBER) {
      trailer = parseJson<ArchiveTrailer>(member.data, TRAILER_MEMBER)
      return
    }
    foldMember(hash, member.path, member.data)
    members++
    const table = databaseMemberTable(member.path)
    if (member.path === MANIFEST_MEMBER) {
      manifest = parseJson<ArchiveManifest>(member.data, MANIFEST_MEMBER)
    } else if (member.path === DATABASE_MEMBER) {
      legacyDump = parseJson<Backup>(member.data, DATABASE_MEMBER)
    } else if (table) {
      await stageDumpMember(stagingDirectory, dumpMembers, { table, path: member.path, data: member.data })
    }
  })

  if (!manifest) {
    throw new Error('Not a backup archive: no manifest.json')
  }
  if (!legacyDump && manifest.formatVersion < 3) {
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
  const database = legacyDump
    ? backupSource(legacyDump)
    : stagedDumpSource({ tables: manifest.database.tables, members: dumpMembers })
  return { manifest, trailer, database }
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
 * Takes the whole verified archive, manifest AND trailer, because the trailer
 * is what says which members were executable. An optional trailer here meant a
 * caller could restore every file at 0644 without anything saying so.
 *
 * Call `readBackupArchive` first. This does not verify; it applies.
 */
export async function extractBackupFiles(
  srcPath: string,
  dataDirectory: string,
  { manifest, trailer }: Pick<BackupArchive, 'manifest' | 'trailer'>,
): Promise<ExtractResult> {
  const roots = manifest.fileRoots
  const created = new Set<string>()
  for (const root of roots) {
    const rootDirectory = path.resolve(dataDirectory, ...root.split('/'))
    await fs.rm(rootDirectory, { recursive: true, force: true })
    await fs.mkdir(rootDirectory, { recursive: true })
    created.add(rootDirectory)
  }
  const executables = new Set(trailer.executables)
  const result: ExtractResult = { roots: [...roots], files: 0, directories: 0 }
  // A directory member always precedes what is inside it, so by the time a
  // file lands its parent has usually been made already — measured at 92% of
  // them. The rest are checkouts, where the walk lists `src/foo.ts` with no
  // member for `src/`, so the fallback still has to exist.
  const ensureDirectory = async (directory: string) => {
    if (!created.has(directory)) {
      await fs.mkdir(directory, { recursive: true })
      created.add(directory)
    }
  }
  await readZip(srcPath, async (member) => {
    const target = resolveFileMember(member.path, dataDirectory, roots)
    if (!target) {
      return
    }
    if (member.isDirectory) {
      await ensureDirectory(target)
      result.directories++
      return
    }
    await ensureDirectory(path.dirname(target))
    await fs.writeFile(target, member.data)
    if (executables.has(member.path)) {
      await fs.chmod(target, 0o755)
    }
    result.files++
  })
  return result
}

import fs from 'node:fs/promises'
import path from 'node:path'

import type { BackupSource } from '@opencroft/db/backup'

// The database half of a backup archive: each covered table's rows as JSON
// Lines, one row per line, cut into members of bounded size.
//
//   database/<table>/000000.jsonl, 000001.jsonl, ...
//
// NO VALUE HERE IS EVER THE WHOLE DUMP. Serialised in one piece, a dump is one
// string, and V8 refuses a string past about 512 MiB — some ninety stored
// attachments at their size ceiling. Here the largest string is one row and
// the largest buffer one member: rows are appended until a member reaches
// `MEMBER_TARGET_BYTES`, so a member is at most that plus one row.
//
// Both directions stage the members on disk rather than holding them. Writing,
// because the manifest goes first in the archive and carries the row counts,
// which are only known once the last row is read. Reading, because a restore
// inserts parents before children in the CURRENT schema's order, which need
// not be the order the archive was written in.

export const DATABASE_PREFIX = 'database/'

export const MEMBER_TARGET_BYTES = 8 * 1024 * 1024

const NEWLINE = 0x0a

export interface DumpMember {
  table: string
  /** Path inside the archive. */
  path: string
  /** Where its bytes are staged on disk. */
  file: string
}

export interface StagedDump {
  /**
   * Covered table -> row count, in the order the tables were dumped. A table
   * with no rows is still here: covering it is the claim that it is empty.
   */
  tables: Record<string, number>
  /** Every member, in archive order. A table's members are in row order. */
  members: DumpMember[]
}

function memberPath(table: string, index: number): string {
  return `${DATABASE_PREFIX}${table}/${String(index).padStart(6, '0')}.jsonl`
}

/** The table a `database/` member holds rows of, or null if `memberPath` is not such a member. */
export function databaseMemberTable(memberPath: string): string | null {
  if (!memberPath.startsWith(DATABASE_PREFIX)) {
    return null
  }
  const rest = memberPath.slice(DATABASE_PREFIX.length)
  const slash = rest.indexOf('/')
  return slash > 0 ? rest.slice(0, slash) : null
}

/**
 * Write one member's bytes into `directory` and add it to `members`.
 *
 * Staged files are named by position, never by table: a table name read out
 * of an uploaded archive is not something to build a path from.
 */
export async function stageDumpMember(
  directory: string,
  members: DumpMember[],
  member: { table: string; path: string; data: Buffer },
): Promise<void> {
  const file = path.join(directory, `${members.length}.jsonl`)
  await fs.writeFile(file, member.data)
  members.push({ table: member.table, path: member.path, file })
}

/** Read each table's rows from `rowsOf` and stage them as archive members under `directory`. */
export async function stageDatabaseDump(
  directory: string,
  tables: readonly string[],
  rowsOf: (table: string) => AsyncIterable<Record<string, unknown>>,
  memberBytes = MEMBER_TARGET_BYTES,
): Promise<StagedDump> {
  await fs.mkdir(directory, { recursive: true })
  const dump: StagedDump = { tables: {}, members: [] }
  for (const table of tables) {
    let lines: Buffer[] = []
    let size = 0
    let rows = 0
    let index = 0
    const flush = async () => {
      await stageDumpMember(directory, dump.members, {
        table,
        path: memberPath(table, index++),
        data: Buffer.concat(lines, size),
      })
      lines = []
      size = 0
    }
    for await (const row of rowsOf(table)) {
      // JSON.stringify escapes every newline inside a value, so one line is
      // exactly one row.
      const line = Buffer.from(`${JSON.stringify(row)}\n`, 'utf8')
      lines.push(line)
      size += line.length
      rows++
      if (size >= memberBytes) {
        await flush()
      }
    }
    if (size > 0) {
      await flush()
    }
    dump.tables[table] = rows
  }
  return dump
}

/** The rows one member's bytes hold. */
export function* memberRows(data: Buffer): Generator<Record<string, unknown>> {
  let start = 0
  while (start < data.length) {
    const newline = data.indexOf(NEWLINE, start)
    const end = newline === -1 ? data.length : newline
    if (end > start) {
      yield JSON.parse(data.toString('utf8', start, end)) as Record<string, unknown>
    }
    start = end + 1
  }
}

/**
 * A staged dump as a restore source, reading each member back from disk when
 * its table's turn comes.
 *
 * A table whose rows do not add up to the count `dump.tables` gives it throws
 * once they are read. A restore consumes rows inside its transaction, so the
 * throw undoes the restore rather than landing a table that disagrees with
 * the manifest the person confirmed.
 */
export function stagedDumpSource(dump: StagedDump): BackupSource {
  return {
    tables: Object.keys(dump.tables),
    async *rows(table) {
      let rows = 0
      for (const member of dump.members) {
        if (member.table === table) {
          for (const row of memberRows(await fs.readFile(member.file))) {
            rows++
            yield row
          }
        }
      }
      if (rows !== dump.tables[table]) {
        throw new Error(`Backup archive holds ${rows} ${table} rows where its manifest says ${dump.tables[table]}`)
      }
    },
  }
}

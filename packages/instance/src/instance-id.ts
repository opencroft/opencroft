import { randomUUID } from 'node:crypto'
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import path from 'node:path'

import { dataDir } from './data-dir'

// Named after the background-task registry, its first reader. The registry's rows are scoped by
// the id this file holds, so a new name would orphan the tasks running at the next start.
const INSTANCE_ID_FILE = 'background-tasks-instance'

let cached: string | undefined

/**
 * This instance's id: made once and kept on the instance's own data volume, which is per-instance
 * by construction, unlike the database, which several deployments can share. It sits at the top of
 * the data directory, which a backup does not carry (`BACKUP_FILE_ROOTS` in `@opencroft/db-backups`),
 * so an instance restored from another's backup makes an id of its own.
 */
export function instanceId(): string {
  cached ??= readOrCreateInstanceId(dataDir(INSTANCE_ID_FILE))
  return cached
}

/** The id `file` holds; undefined when there is no file, empty when the file is. */
function readId(file: string): string | undefined {
  try {
    return readFileSync(file, 'utf8').trim()
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') {
      return undefined
    }
    throw err
  }
}

/**
 * The id `file` holds, or a new one written there. Instances that share a data volume (one
 * deployment run twice) share the id: the file is created exclusively, and whoever loses the race
 * reads the winner's.
 */
export function readOrCreateInstanceId(file: string): string {
  const existing = readId(file)
  if (existing) {
    return existing
  }
  const id = randomUUID()
  mkdirSync(path.dirname(file), { recursive: true })
  try {
    // An empty file is a write that never finished, and is replaced.
    writeFileSync(file, `${id}\n`, { flag: existing === undefined ? 'wx' : 'w' })
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== 'EEXIST') {
      throw err
    }
    const winner = readId(file)
    if (!winner) {
      throw new Error(`The instance id file ${file} is being written by another process; try again.`)
    }
    return winner
  }
  return id
}

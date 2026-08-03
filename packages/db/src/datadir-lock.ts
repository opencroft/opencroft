// An advisory lock on a PGlite data directory.
//
// PGlite is single-writer by design but does not enforce it: a second process
// opens a datadir another process is holding, succeeds, reads a *different,
// older* database, and on close can silently discard everything the first
// process wrote. Both sides exit 0 and nothing reports a problem. That was
// measured, not inferred, and it has already destroyed two databases here,
// each of which needed a manual WAL reset to bring back.
//
// The lock is a listening unix domain socket next to the datadir. The kernel
// owns the binding, which gives the two properties that matter:
//
//   * Only one process can be bound to a path at a time. A second bind fails
//     with EADDRINUSE — not a heuristic, a syscall result.
//   * The binding is released when the holder dies, by any means, including
//     SIGKILL and a container being torn out from under it. There is no such
//     thing as a stale lock, so a hard kill cannot brick the next startup.
//
// It deliberately is NOT a lockfile carrying a pid. A pid is meaningless
// across containers — the two real incidents here were another container
// opening the datadir over a shared mount, where /proc holds no entry for the
// holder at all (measured). A unix socket is reached through the filesystem,
// so it works over exactly the same shared mount that makes the accident
// possible in the first place.
//
// The stronger primitive would be flock(2), which has no takeover window at
// all. It is not available: Node exposes no flock, and every module that does
// builds from source, while the runtime image this ships in carries no
// compiler at all (no python3, make or cc — checked). Adding one would trade
// silent data loss for `npm ci` failing on every deploy.

import { unlinkSync } from 'node:fs'
import net from 'node:net'
import os from 'node:os'
import path from 'node:path'

// How long to wait for the holder to say who it is. The refusal does NOT
// depend on this: connect() completing is a kernel fact, so a holder that is
// alive but too busy to answer (PGlite runs queries in wasm on the main
// thread, so this is normal) is still correctly detected as alive. Only the
// name in the message is best-effort.
const IDENTITY_TIMEOUT_MS = 500

// Bounded so a pathological loop of "stale, take over, lost it again" ends in
// a refusal rather than spinning.
const ACQUIRE_ATTEMPTS = 3

export interface DatadirHolder {
  host: string
  pid: number
  script: string
  since: string
}

export class DatadirBusyError extends Error {
  override readonly name = 'DatadirBusyError'
  readonly code = 'DATADIR_BUSY'
  readonly holder: DatadirHolder | null

  constructor(message: string, holder: DatadirHolder | null) {
    super(message)
    this.holder = holder
  }
}

export interface DatadirLock {
  readonly lockPath: string
  release(): Promise<void>
}

/**
 * The lock path for a datadir: a sibling, never a child.
 *
 * PGlite runs initdb only when the directory is empty, so a file of ours
 * inside it would make a fresh datadir look already-initialised. The trailing
 * separator is stripped first — without that, a configured path ending in `/`
 * would put the socket *inside* the directory, which is the one place it must
 * not go.
 */
export function lockPathFor(dataDir: string): string {
  const normalised = path.resolve(dataDir)
  return `${normalised}.lock`
}

// argv[1] only, never the whole command line: anything that can reach the
// socket path can read this, and the one-shot scripts that open this database
// take flag values that should not be republished.
function describeSelf(): DatadirHolder {
  return {
    host: os.hostname(),
    pid: process.pid,
    script: process.argv[1] ?? '<unknown>',
    since: new Date().toISOString(),
  }
}

type ListenResult = { ok: true; server: net.Server } | { ok: false; code: string | undefined }

function listenExclusive(lockPath: string, self: DatadirHolder): Promise<ListenResult> {
  return new Promise((resolve) => {
    const payload = JSON.stringify(self)
    const server = net.createServer((socket) => {
      // A peer that hangs up mid-write must not raise an unhandled error in
      // the process that owns the database.
      socket.on('error', () => {})
      socket.end(payload)
    })
    // The lock must never be the reason a process stays alive: an unref'd
    // server still accepts connections, but does not hold the event loop open.
    server.unref()

    let settled = false
    server.on('error', (error: NodeJS.ErrnoException) => {
      if (!settled) {
        settled = true
        resolve({ ok: false, code: error.code })
        return
      }
      // Already holding the lock. A later socket error is not worth taking the
      // database down for, and an unhandled 'error' event would do exactly that.
    })
    server.listen(lockPath, () => {
      if (!settled) {
        settled = true
        resolve({ ok: true, server })
      }
    })
  })
}

function parseHolder(raw: string): DatadirHolder | null {
  try {
    const parsed = JSON.parse(raw) as Partial<DatadirHolder>
    if (typeof parsed.host !== 'string' || typeof parsed.pid !== 'number') {
      return null
    }
    return {
      host: parsed.host,
      pid: parsed.pid,
      script: typeof parsed.script === 'string' ? parsed.script : '<unknown>',
      since: typeof parsed.since === 'string' ? parsed.since : '<unknown>',
    }
  } catch {
    return null
  }
}

/**
 * Ask whoever is at `lockPath` whether they are alive, and who they are.
 *
 * `alive` is decided by whether the kernel completed the connection, not by
 * whether an answer came back. Every uncertain outcome resolves to alive:
 * refusing to open a database that might be held is recoverable, opening one
 * that is held is the data loss this exists to prevent.
 */
function probeHolder(lockPath: string): Promise<{ alive: boolean; holder: DatadirHolder | null }> {
  return new Promise((resolve) => {
    let settled = false
    let raw = ''
    const socket = net.connect(lockPath)

    const finish = (alive: boolean, holder: DatadirHolder | null) => {
      if (settled) return
      settled = true
      socket.destroy()
      resolve({ alive, holder })
    }

    const timer = setTimeout(() => finish(true, null), IDENTITY_TIMEOUT_MS)
    timer.unref()

    socket.on('data', (chunk) => {
      raw += chunk
    })
    socket.on('end', () => {
      clearTimeout(timer)
      finish(true, parseHolder(raw))
    })
    socket.on('error', (error: NodeJS.ErrnoException) => {
      clearTimeout(timer)
      // ECONNREFUSED: the file is there but nothing is listening — the holder
      // died without cleaning up, which is the case a hard kill leaves behind.
      // ENOENT: it was removed between our failed bind and this connect.
      // ENOTSOCK: something that is not a socket is sitting at that path.
      const dead = error.code === 'ECONNREFUSED' || error.code === 'ENOENT' || error.code === 'ENOTSOCK'
      finish(!dead, null)
    })
  })
}

function refusalMessage(dataDir: string, holder: DatadirHolder | null): string {
  const who = holder
    ? `  holder: host=${holder.host} pid=${holder.pid} script=${holder.script} open since ${holder.since}`
    : '  holder: alive, but did not answer in time to identify itself'
  return [
    `Refusing to open the PGlite database at ${dataDir}: another process already has it open.`,
    '',
    who,
    '',
    'PGlite does not lock its datadir, so without this check the open would',
    'have SUCCEEDED, returned a stale copy of the database, and on close could',
    "have silently discarded the holder's writes — both processes exiting 0.",
    '',
    'If the holder is the app, stop it first. Nothing needs cleaning up by',
    'hand: the lock is released the moment the holding process is gone, even',
    'if it is killed outright.',
  ].join('\n')
}

/**
 * Take the advisory lock for `dataDir`, or throw `DatadirBusyError`.
 *
 * Call this at the point a datadir is opened, not wherever a driver happens to
 * be constructed: the lock is keyed to the directory, so throwaway datadirs
 * (one per test run) never contend with each other or with the app's.
 */
export async function lockDatadir(dataDir: string): Promise<DatadirLock> {
  const lockPath = lockPathFor(dataDir)
  const self = describeSelf()

  for (let attempt = 1; attempt <= ACQUIRE_ATTEMPTS; attempt++) {
    const listened = await listenExclusive(lockPath, self)
    if (listened.ok) {
      return {
        lockPath,
        release: () =>
          new Promise<void>((resolve) => {
            // Node unlinks the socket path itself on close. Doing it again
            // here would risk deleting a *different* process's socket if one
            // has already taken the lock in between.
            listened.server.close(() => resolve())
          }),
      }
    }

    if (listened.code !== 'EADDRINUSE') {
      // Not contention — the lock could not be created at all (a path over the
      // ~108 byte sockaddr_un limit, a filesystem that cannot hold a socket, a
      // permissions problem). Failing here is deliberate: falling back to an
      // unlocked open would restore exactly the silent corruption this
      // prevents, and this class of failure is deterministic, so it surfaces
      // on the first run rather than during an incident.
      throw new Error(
        `Could not create the database lock at ${lockPath} (${listened.code ?? 'unknown error'}). ` +
          'The database was not opened. This is a configuration problem with the datadir path, not contention.',
      )
    }

    const probe = await probeHolder(lockPath)
    if (probe.alive) {
      throw new DatadirBusyError(refusalMessage(dataDir, probe.holder), probe.holder)
    }

    // Nothing is listening: the socket file outlived its process. Remove it
    // and try again.
    try {
      unlinkSync(lockPath)
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') {
        throw error
      }
    }
  }

  throw new DatadirBusyError(
    `Could not take the database lock at ${lockPath} after ${ACQUIRE_ATTEMPTS} attempts: ` +
      'it was taken by another process each time it was released. The database was not opened.',
    null,
  )
}

import { mkdtempSync, readdirSync, rmSync, statSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'

const PREFIX = 'opencroft-test-pglite-'

/**
 * How old a leftover datadir must be before this file will remove one it does not own.
 *
 * **The criterion is age since creation, and that is a stronger guarantee than "age" sounds.**
 * Measured 2026-09-08: one of these directories has its own mtime moved when PGlite initialises a
 * cluster inside it -- 2.3s after the mkdtemp -- and then it does not move again however much the
 * database is written to (80 statements, +0ms), because the writes land in child directories. So
 * the mtime is, in practice, the moment the process that owns it started.
 *
 * That answers the question this constant exists to answer. A run in flight cannot have its datadir
 * swept by a process that starts a second later, or an hour later: to be eligible the directory
 * must have been created more than STALE_MS ago, which means the run holding it has been going that
 * long. Six hours, against measured full-suite runs of six to fifteen minutes.
 *
 * The two mistakes are not symmetric, which is why the margin is an order of magnitude rather than
 * a factor of two: being too generous leaves a few hours of directories nobody is using, and being
 * too eager deletes the database of a run that is still going.
 *
 * **The package's own datadir lock is the sound liveness signal and is deliberately not used here.**
 * It is a unix socket the kernel releases however the holder dies, so it has no stale state -- but
 * asking it anything is asynchronous, and this runs during module evaluation in a preload. Keying
 * on the socket FILE being present instead would be synchronous and would invert the fix: a hard
 * kill leaves that file behind on precisely the datadirs that were opened, which are the large ones
 * worth collecting.
 */
const STALE_MS = 6 * 60 * 60 * 1000

/**
 * How many leftovers one process will collect before leaving the rest to the next one.
 *
 * The sweep exists for the odd datadir a killed run left, and for that it never binds. It binds on
 * a backlog accumulated before any of this existed — 21,017 directories, ~235 GiB, on one host,
 * 2026-09-08 — where one unlucky test process would otherwise spend minutes deleting other
 * people's leftovers and look, from outside, exactly like a hung suite.
 *
 * **The bound spreads that work, it does not remove it.** A run puts every test FILE in its own
 * process, so a backlog is paid for across all of them rather than by one — which is still a slower
 * run, and still the symptom this number exists to avoid. A backlog of that size was therefore
 * cleared out of band rather than left to drain through test runs, which is what makes this a
 * safety margin rather than a mechanism anything relies on.
 */
const MAX_SWEEP = 200

/**
 * Remove `dir` when this process ends, however it ends.
 *
 * `exit` is the only hook that covers both a normal finish and a thrown failure, and it runs
 * synchronously, which is why the removal is `rmSync`. It does NOT cover a signal: the default
 * disposition of SIGINT/SIGTERM is to terminate without running exit handlers, so a killed run was
 * exactly the case that leaked -- and a killed run is when it matters most, because a run is most
 * often killed when the disk is already full.
 *
 * The signal handlers re-raise rather than exiting themselves, so the process still dies of what
 * killed it and the exit status still says so. If something else is also listening, it keeps its
 * turn and decides how the process ends; the directory is already gone either way.
 */
function removeWhenThisProcessEnds(dir: string): void {
  const remove = () => {
    try {
      rmSync(dir, { recursive: true, force: true })
    } catch {
      /* A datadir that cannot be removed is not worth failing a test run over: the sweep below is
         what makes the leak bounded, and this is only the fast path. */
    }
  }

  process.on('exit', remove)

  for (const signal of ['SIGINT', 'SIGTERM', 'SIGHUP'] as const) {
    const onSignal = () => {
      remove()
      process.off(signal, onSignal)
      if (process.listenerCount(signal) === 0) {
        process.kill(process.pid, signal)
      }
    }
    process.on(signal, onSignal)
  }
}

/**
 * Remove datadirs left behind by runs that ended in a way no handler above can see -- SIGKILL, an
 * OOM kill, a host that went down.
 *
 * Everything above is best-effort by construction, so this is what makes the bound real rather
 * than hoped for: whatever escapes, the next run collects. It reads one directory and stats the
 * entries matching the prefix, which is free once the backlog it was written for has drained.
 *
 * Two narrowings guard it — the path in use, and directories only — and they interact. The whole
 * enumeration, so the next reader does not re-derive three safe cases to find the fourth:
 *
 *   caller-supplied PGLITE_PATH is a socket    skipped twice: by `inUse` and by the directory
 *                                             filter. Over-covered, not under.
 *   lock held by THIS process                  the holder's PGLITE_PATH is that datadir, so `inUse`
 *                                             skips it; its lock is skipped as a non-directory.
 *   lock held by ANOTHER process               NOT CLOSED, and known. Reachable only if that run
 *                                             has been going longer than STALE_MS: its datadir is
 *                                             collected and its socket is left holding a path whose
 *                                             database is gone. The only sound signal is whether
 *                                             the socket is BOUND, and asking that is asynchronous;
 *                                             the synchronous proxy inverts the fix (see STALE_MS).
 *   orphaned socket, datadir already gone      left alone. Zero bytes, and `lockDatadir` unlinks it
 *                                             itself when it next finds nothing listening.
 */
function sweepStaleDatadirs(): void {
  const root = tmpdir()
  const cutoff = Date.now() - STALE_MS
  // The datadir this process is actually using, whoever chose it. Age alone does not protect it:
  // the one path a person supplies BY HAND is re-pointing PGLITE_PATH at a previous run's leftover
  // to look inside it, and that directory carries this prefix, sits in this directory, and is older
  // than the cutoff by the time they get to it -- so it is indistinguishable from litter by every
  // other signal here, and it is the one thing in tmpdir somebody deliberately kept.
  const inUse = process.env.PGLITE_PATH ? resolve(process.env.PGLITE_PATH) : undefined
  let entries: string[]
  try {
    entries = readdirSync(root)
  } catch {
    return
  }
  let collected = 0
  for (const entry of entries) {
    if (collected >= MAX_SWEEP) {
      return
    }
    if (!entry.startsWith(PREFIX)) {
      continue
    }
    const full = join(root, entry)
    if (inUse && resolve(full) === inUse) {
      continue
    }
    try {
      const stat = statSync(full)
      // Directories only. The datadir lock puts its socket at `<datadir>.lock`, a SIBLING, so it
      // carries this prefix too -- and it is the one thing here that must never be removed while
      // anything might hold it. Unlinking a bound socket does not stop the holder, but it frees the
      // path for a second process to bind, and then two processes each believe they have exclusive
      // use of one datadir, which is the silent corruption that lock exists to prevent. A socket
      // whose run died is cleaned up by `lockDatadir` itself, and it costs nothing meanwhile: it is
      // zero bytes, and this leak was measured in gigabytes of directories.
      if (stat.isDirectory() && stat.mtimeMs < cutoff) {
        rmSync(full, { recursive: true, force: true })
        collected += 1
      }
    } catch {
      /* Raced with another run's own cleanup, or is not ours to remove. Either way the next sweep
         asks again, and neither is a reason to fail the run that happened to notice. */
    }
  }
}

// Importing this file IS the guard, and it must be a test file's first
// import: openDb() picks node-postgres over PGlite purely on whether
// DATABASE_URL is set, with no way to tell "the real app started" from "a
// test forgot to isolate itself" apart -- so the only safe rule is that no
// test process ever gets to see a real DATABASE_URL, and always has a
// PGlite datadir of its own to fall back on. A test that wants a specific
// datadir (most do, for per-suite isolation) just overwrites PGLITE_PATH
// afterward; this only fills in what would otherwise be left unset.
if (process.env.DATABASE_URL) {
  delete process.env.DATABASE_URL
}
if (!process.env.PGLITE_PATH) {
  // Created eagerly rather than named and left to PGlite, because mkdtemp is what makes the name
  // unique atomically. Most of these are then never opened at all -- a suite that sets its own
  // PGLITE_PATH afterward leaves this one empty -- but an empty directory still has to be removed
  // by whoever made it, which is the whole of the leak this file used to be.
  const dir = mkdtempSync(join(tmpdir(), PREFIX))
  process.env.PGLITE_PATH = dir
  removeWhenThisProcessEnds(dir)
}

sweepStaleDatadirs()

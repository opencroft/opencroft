import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

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
  process.env.PGLITE_PATH = mkdtempSync(join(tmpdir(), 'opencroft-test-pglite-'))
}

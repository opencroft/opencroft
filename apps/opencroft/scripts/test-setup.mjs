// Preloaded (via --import) before every test file's own top-level code runs.
//
// Most suites that touch the database set their own throwaway PGLITE_PATH
// before importing anything from @opencroft/db. This covers the rest: a test
// file that reaches the db package only as a side effect of an unrelated
// import chain, with no PGLITE_PATH of its own. Without this, that suite
// falls through to connect.ts's default -- a real, persistent data directory
// under the workspace -- which is the wrong place for anything a test run
// creates.
if (!process.env.PGLITE_PATH) {
  const { mkdtempSync } = await import('node:fs')
  const { tmpdir } = await import('node:os')
  const { join } = await import('node:path')
  const dir = mkdtempSync(join(tmpdir(), 'opencroft-test-'))
  process.env.PGLITE_PATH = join(dir, 'pglite')
}

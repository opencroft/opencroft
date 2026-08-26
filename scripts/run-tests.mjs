// Shared by every workspace's own "test" script. Runs from that workspace's
// directory (as npm sets cwd for `npm run test -w <name>`), so tsx resolves
// that workspace's own tsconfig.json paths -- running from the repo root
// instead resolves the wrong (or no) path aliases and every `@/...` import
// fails to resolve.
//
// Finds every *.test.ts(x) under the given roots (relative to cwd, default
// ["src"]) and runs them through Node's test runner via tsx, one file at a
// time. Serial, not parallel: some suites share the PGlite-per-datadir
// pattern, and PGlite itself does not lock a datadir -- two processes against
// the same directory corrupt it silently. packages/db now takes an advisory
// lock and refuses the second opener, so that no longer passes unnoticed --
// but a refusal is still a failed run, so these stay serial.

import { spawnSync } from 'node:child_process'
import { existsSync, readdirSync, statSync } from 'node:fs'
import { join, relative, resolve } from 'node:path'

const roots = process.argv.slice(2)
if (roots.length === 0) {
  roots.push('src')
}

const testFiles = []

function walk(dir) {
  for (const entry of readdirSync(dir)) {
    if (entry === 'node_modules') continue
    const full = join(dir, entry)
    if (statSync(full).isDirectory()) {
      walk(full)
    } else if (entry.endsWith('.test.ts') || entry.endsWith('.test.tsx')) {
      testFiles.push(full)
    }
  }
}

for (const root of roots) {
  if (existsSync(root)) {
    walk(root)
  }
}

testFiles.sort()
// Read by check-baseline.mjs, which pairs one totals line against each suite
// that had files to run -- a workspace with a test script and no test files
// exits below without producing any. Reword this and that audit stops finding
// what it counts, with nothing to fail the build.
console.log(`Found ${testFiles.length} test files.\n`)

if (testFiles.length === 0) {
  process.exit(0)
}

const args = ['tsx']
// A workspace-local preload -- e.g. one that gives DB-touching suites a
// default throwaway datadir -- is opted into by placing it at this path.
if (existsSync('scripts/test-setup.mjs')) {
  args.push('--import', './scripts/test-setup.mjs')
}
args.push('--test', '--test-concurrency=1')
// Node picks its reporter from whether stdout is a terminal, so a caller that
// captures this output gets one format interactively and another through a
// pipe. check-baseline reads these results, so it asks for the machine-readable
// one by name rather than depending on which side of that default it landed on.
if (process.env.OPENCROFT_TEST_TAP) {
  args.push('--test-reporter=tap', '--test-reporter-destination=stdout')
}
args.push(...testFiles.map((f) => relative('.', f)))

const env = { ...process.env }
// A workspace-local tsconfig.test.json is the test runner's own answer to
// rendering JSX: the shared tsconfig leaves the transform to the bundler
// (`jsx: preserve`), which the runner has none of, so a component throws
// `React is not defined` under its classic-transform fallback. tsx compiles
// against whichever tsconfig TSX_TSCONFIG_PATH names instead of the nearest
// one on disk, so this reaches only the runner -- the workspace's real
// tsconfig.json, read by typecheck and the build, is untouched.
if (existsSync('tsconfig.test.json')) {
  env.TSX_TSCONFIG_PATH = resolve('tsconfig.test.json')
}

const result = spawnSync('npx', args, { stdio: 'inherit', env })
process.exit(result.status ?? 1)

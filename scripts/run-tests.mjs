// Shared by every workspace's own "test" script. Runs from that workspace's
// directory (as npm sets cwd for `npm run test -w <name>`), so tsx resolves
// that workspace's own tsconfig.json paths -- running from the repo root
// instead resolves the wrong (or no) path aliases and every `@/...` import
// fails to resolve.
//
// Finds every *.test.ts(x) under the given roots (relative to cwd, default
// ["src"]) and runs them through Node's test runner via tsx, one file at a
// time. Serial, not parallel: some suites share the PGlite-per-datadir
// pattern, and PGlite has no datadir lock -- two processes against the same
// directory race on schema creation instead of failing loudly.
import { existsSync, readdirSync, statSync } from 'node:fs'
import { spawnSync } from 'node:child_process'
import { join, relative } from 'node:path'

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
args.push('--test', '--test-concurrency=1', ...testFiles.map((f) => relative('.', f)))

const result = spawnSync('npx', args, { stdio: 'inherit' })
process.exit(result.status ?? 1)

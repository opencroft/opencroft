// Runs tsc --noEmit for the current package and separates real, in-scope errors
// from cross-package noise.
//
// A package's own tsconfig only sets `include`, not `exclude` -- so when it
// imports something like the `ui` package (whose exports map points straight
// at @/-aliased source instead of a built/declared boundary), tsc pulls that
// source in too and misresolves its internal aliases against the consumer's
// own path mapping. That produces dozens of "Cannot find module '@/...'"
// errors that belong to the dependency, not this package, and would make a
// naive per-package gate too noisy to trust. Each affected package
// typechecks itself separately, so those files are already covered there;
// here they're just filtered out and counted, not silently dropped.
//
// A `.typecheck-baseline` file (one error signature per line, produced by
// this same filtering with line/column stripped) lets a package carry known,
// already-scoped debt without either hiding it or blocking every unrelated
// change. No file means zero tolerance.
import { existsSync, readFileSync } from 'node:fs'
import { spawnSync } from 'node:child_process'

const roots = process.argv.slice(2)
if (roots.length === 0) {
  roots.push('src')
}

const result = spawnSync('npx', ['tsc', '--noEmit', '-p', 'tsconfig.json'], { encoding: 'utf8' })
const output = `${result.stdout || ''}${result.stderr || ''}`
const lines = output.split('\n').filter((line) => line.length > 0)

const errorPattern = /^(.+?)\(\d+,\d+\): (error TS\d+: .*)$/
const entries = []
const unrecognized = []

for (const line of lines) {
  const match = line.match(errorPattern)
  if (match) {
    const [, file, rest] = match
    const isOwned = roots.some((root) => file === root || file.startsWith(`${root}/`))
    entries.push({ isOwned, signature: `${file}: ${rest}` })
    continue
  }
  // tsc wraps a diagnostic's extra detail (e.g. missing properties) on
  // indented continuation lines with no file/position of its own -- fold
  // those into the diagnostic they belong to instead of flagging them.
  if (/^\s/.test(line) && entries.length > 0) {
    entries[entries.length - 1].signature += ` ${line.trim()}`
    continue
  }
  unrecognized.push(line)
}

const owned = entries.filter((entry) => entry.isOwned).map((entry) => entry.signature)
const foreign = entries.filter((entry) => !entry.isOwned).map((entry) => entry.signature)

const baselinePath = '.typecheck-baseline'
const baseline = existsSync(baselinePath)
  ? new Set(readFileSync(baselinePath, 'utf8').split('\n').filter((line) => line.length > 0))
  : new Set()

const newOwned = owned.filter((signature) => !baseline.has(signature))

if (foreign.length > 0) {
  console.log(`${foreign.length} cross-package diagnostic(s) ignored -- caught by that package's own typecheck run.`)
}

if (unrecognized.length > 0) {
  console.log('Unrecognized tsc output (treated as a failure):')
  console.log(unrecognized.join('\n'))
  process.exit(1)
}

if (newOwned.length > 0) {
  console.log(`${newOwned.length} new error(s):`)
  console.log(newOwned.join('\n'))
  process.exit(1)
}

if (owned.length > 0) {
  console.log(`${owned.length} known baseline error(s), no new ones. See .typecheck-baseline.`)
  process.exit(0)
}

// A non-zero tsc exit with no diagnostic classified either way (owned or
// foreign) means something failed outside the normal error-reporting shape
// (e.g. a bad tsconfig) -- surface it instead of reporting a silent pass.
if (entries.length === 0 && result.status !== 0) {
  console.log(`tsc exited ${result.status} with no parseable error line:`)
  console.log(output)
  process.exit(1)
}

console.log('typecheck OK')

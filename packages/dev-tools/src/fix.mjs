// `opencroft-dev fix`: the one command a repository runs before every commit.
//
//   1. write  biome's safe fixes, formatting and import order, written to disk,
//             on the files this checkout changed (or every file with --all);
//   2. lint   biome over the WHOLE repository, nothing tolerated;
//   3. types  the repository's typecheck (typecheck.mjs), nothing tolerated.
//
// It exits non-zero on anything left, so a clean exit means the repository has
// no lint finding and no type error at all, not merely none in the change.
//
// WHY WRITING TOUCHES ONLY THE CHANGED FILES
//
// A task's diff should hold the task. A file the task touches is formatted
// whole, which is the cost of touching it; `--all` writes every file, for the
// one-off commit that formats a repository on purpose. The verdict in steps 2
// and 3 is not scoped this way: it covers every file, so nothing old can hide.
//
// Installed files are never written or linted, changed or not: the next
// install would overwrite the edit, and a finding in one is its registry's to
// fix (installed.mjs).
//
// WHAT ITS EXIT CODE MEANS
//
// 0 clean; 1 a lint finding or a type error remains; 2 a step could not run
// or its result could not be believed. Every step runs whatever the one before
// it found, so one run reports everything that is left.

import { biomeBinary, runBiome } from './biome.mjs'
import { installDirectories, isInstalled } from './installed.mjs'
import { lint } from './lint.mjs'
import { allFiles, changedFiles, describeTree, resolveBase } from './repo.mjs'
import { typecheck } from './typecheck.mjs'

/** Step 1. Returns 0, or 2 when biome could not be run or read. */
function write(root, { all, base: explicitBase }) {
  let scope
  let candidates
  if (all) {
    candidates = allFiles(root)
    scope = 'every file'
  } else {
    const base = resolveBase(root, explicitBase)
    const changed = changedFiles(root, base)
    candidates = changed.files
    scope = `files changed against ${base} (merge-base ${changed.mergeBase.slice(0, 12)})`
  }
  // Installed directories are derived from the whole tree, not the change: a
  // task that edits an installed file has not necessarily touched the
  // components.json that makes it one.
  const dirs = installDirectories(root, allFiles(root))
  const targets = candidates.filter((file) => !isInstalled(dirs, file))
  const skipped = candidates.length - targets.length

  console.log(`  write     ${scope}`)
  console.log(`            ${targets.length} file(s)${skipped > 0 ? ` (${skipped} installed file(s) left alone)` : ''}`)
  if (targets.length === 0) {
    console.log('            nothing to write: no file of this repository is in scope.')
    return 0
  }
  const run = runBiome(root, targets, ['--write', '--reporter=json', '--max-diagnostics=none'])
  if (run.error) {
    console.error(`opencroft-dev fix: could not run biome: ${run.error.message}`)
    return 2
  }
  let parsed
  try {
    parsed = JSON.parse(run.stdout)
  } catch (err) {
    const said = run.stderr.trim().split('\n').slice(0, 5).join('\n')
    console.error(`opencroft-dev fix: biome's JSON could not be parsed: ${err.message}${said ? `\n${said}` : ''}`)
    return 2
  }
  console.log(`            rewrote ${parsed.summary?.changed ?? 0}`)
  return 0
}

/** Step 2. Returns the lint exit code and prints every finding. */
function verdict(root) {
  const result = lint(root)
  if (result.code === 2) {
    console.error(`opencroft-dev fix: ${result.reason}`)
    console.error('Nothing is being reported as clean: this is a failure of the check, not a verdict on the tree.')
    return 2
  }
  console.log(`  lint      ${result.scanned} file(s), ${result.findings.length} finding(s)`)
  for (const f of result.findings) {
    const place = f.line === null ? f.file : `${f.file}:${f.line}:${f.column}`
    console.log(`            ${place}  ${f.rule}  ${f.message}`)
  }
  if (result.findings.some((f) => f.rule === 'format')) {
    console.log(
      '            `format` marks an unformatted file this change did not touch; `npm run fix -- --all` writes it',
    )
  }
  return result.code
}

export function fix(root, { all = false, base = null } = {}) {
  const { version } = biomeBinary()
  console.log('── opencroft-dev fix ───────────────────────────────────────────')
  console.log(`  biome     ${version}`)
  console.log(`  commit    ${describeTree(root)}`)

  const written = write(root, { all, base })
  const linted = verdict(root)
  const typed = typecheck(root)

  const codes = [written, linted, typed]
  const code = codes.includes(2) ? 2 : codes.includes(1) ? 1 : 0
  console.log('── opencroft-dev fix ───────────────────────────────────────────')
  console.log(
    `  verdict   ${code === 0 ? 'PASS' : 'FAIL'} (write ${label(written)}, lint ${label(linted)}, typecheck ${label(typed)})`,
  )
  return code
}

const label = (code) => (code === 0 ? 'ok' : code === 1 ? 'findings' : 'could not run')

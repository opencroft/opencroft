#!/usr/bin/env node
// Runs biome over the whole tree and reports the DELTA against what is already
// written down, not the state of the tree.
//
// WHY THIS EXISTS
//
// `biome check` has never been green here. Measured on 2026-09-14: the tree was
// reformatted wholesale on 2026-06-13 and the linter was switched to
// `recommended: true` over code that did not satisfy it, so the check has been
// red every day since — 164 lint errors then, 116 now, plus formatting and
// import-order drift accumulated over a thousand commits.
//
// A check that cannot be got green stops being a signal, and it puts every
// author in front of two bad options: fix strangers' findings and pollute a
// review with unrelated lines, or hand over a red check that has to be
// explained every time, which teaches everyone to read red as normal.
//
// So: rules stay at FULL STRENGTH in the config — editors go on showing
// everything — and today's debt is enumerated in lint-baseline.json, keyed by
// file and rule. Nothing is demoted. A demoted rule protects the old code by
// unprotecting the new, trading a measured number for an unmeasured future.
//
// THE GATE IS TWO-SIDED
//
// It fails on anything in EXCESS of the baseline, which is the half everyone
// expects, and it also fails when findings fall BELOW it. A baseline entry
// larger than reality is a licence: an entry of 2 over an actual 1 lets the
// next instance of that rule land green. So fixing debt means regenerating the
// baseline in the same change (`--update`), and the number is exact at every
// commit rather than exact on the day it was written.
//
// That exactness is why there is no second reporting mechanism. The baseline
// IS the report — it can only move down, and it cannot go stale.
//
// ONE INSTRUMENT
//
// The verdict and the number come from the same run of the same command. There
// is deliberately no second biome invocation for reporting, because two
// invocations can disagree and the one nobody gates on is the one that drifts.
//
// WHAT IT REFUSES TO BELIEVE
//
// `biome check` on a path that does not exist exits 1 — the same code a healthy
// run with findings returns. So the exit code cannot tell this script whether
// biome ran, and every believability check lives in validateRun() instead:
// unreadable JSON, a missing summary, zero files scanned, withheld diagnostics,
// diagnostics with no file or rule, and zero findings while the baseline is not
// empty all FAIL. "Nothing found" and "nothing ran" do not share an answer.
//
// It also runs the lockfile-pinned binary by path and prints its version beside
// the verdict. `npx biome` does not fail when the dependency is missing — it
// fetches an unrelated package of that name which prints nothing and exits 0,
// and a lint gate reporting clean because it ran the wrong program is the worst
// outcome available here.
//
// NOT COVERED BY THIS RESULT
//
// Whether a finding is worth fixing, and whether a suppression is honest. The
// baseline counts what biome reports; a suppression removes a finding from that
// count legitimately, and the rules on suppressions — a written reason, a
// verified attachment, `suppressions/unused` liveness — are code review's,
// not this script's.

import { execFileSync, spawnSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { existsSync, readFileSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

import { aggregate, compare, fromFile, toFile, total, validateRun } from './lint-baseline-report.mjs'

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const BIOME = path.join(ROOT, 'node_modules', '.bin', 'biome')
const BASELINE = path.join(ROOT, 'lint-baseline.json')

const update = process.argv.includes('--update')
const asJson = process.argv.includes('--json')

const die = (reason) => {
  console.error(`check-lint-baseline: ${reason}`)
  console.error('Nothing is being reported as clean — this is a failure of the check, not a verdict on the tree.')
  process.exit(2)
}

if (!existsSync(BIOME)) {
  die(`no biome at ${path.relative(ROOT, BIOME)} — run \`npm ci\` first`)
}

const version = execFileSync(BIOME, ['--version'], { encoding: 'utf8' })
  .trim()
  .replace(/^Version:\s*/, '')

// `--max-diagnostics=none` rather than trusting the reporter's default: the
// default capped nothing when this was measured, and a cap that arrives later
// would truncate the actuals into a well-formed, smaller, wrong list.
const run = spawnSync(BIOME, ['check', '--reporter=json', '--max-diagnostics=none'], {
  cwd: ROOT,
  encoding: 'utf8',
  maxBuffer: 64 * 1024 * 1024,
})
if (run.error) {
  die(`could not run biome — ${run.error.message}`)
}

let parsed
try {
  parsed = JSON.parse(run.stdout)
} catch (err) {
  die(`biome's JSON could not be parsed — ${err.message}`)
}

const { entries: actual, unreadable } = aggregate(parsed.diagnostics)

const baselineRaw = existsSync(BASELINE) ? readFileSync(BASELINE, 'utf8') : null
const baselineFile = baselineRaw ? JSON.parse(baselineRaw) : {}
const { entries: baseline, malformed } = fromFile(baselineFile.entries)
// Not while regenerating: `--update` is the documented recovery for a baseline
// that cannot be read, and the diff it produces is what gets reviewed. Gating
// on it here would leave a corrupted file with no way back through the tool
// that owns it.
if (malformed > 0 && !update) {
  die(`${malformed} baseline entr(ies) could not be read — a baseline that cannot be parsed cannot hold a bar`)
}

/** What the run identifies itself against. A verdict with no tree attached is
 *  not evidence: the block is pasted into a pull request by hand, so it has to
 *  say which commit it ran on and which baseline it compared with, or it could
 *  have come from anywhere. A dirty tree is named rather than hidden, because a
 *  SHA alone would misattribute uncommitted work to the commit. */
const describeTree = () => {
  try {
    const sha = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: ROOT, encoding: 'utf8' }).trim()
    const dirty = execFileSync('git', ['status', '--porcelain'], { cwd: ROOT, encoding: 'utf8' })
      .split('\n')
      .filter(Boolean).length
    return `${sha}${dirty === 0 ? ' (clean)' : ` (+${dirty} uncommitted)`}`
  } catch {
    return 'unknown (not a git checkout)'
  }
}
const baselineHash = baselineRaw
  ? `sha256:${createHash('sha256').update(baselineRaw).digest('hex').slice(0, 12)}`
  : 'absent'

const verdict = validateRun(parsed, { unreadable, baselineEntries: total(baseline) })
if (!verdict.ok) {
  die(verdict.reason)
}

if (update) {
  const next = {
    $schema: 'see scripts/check-lint-baseline.mjs',
    $about: [
      'Biome findings this repository currently carries on its integration branch, keyed by',
      'file and rule. Generated — regenerate with `npm run check -- --update`, never by hand.',
      '',
      'This is a MEASUREMENT, not a set of judgements, which is what makes it generated where',
      'test-baseline.json is hand-written: a tolerated test failure needs a reason a reader can',
      'weigh, and a count of findings is simply true or not.',
      '',
      'The gate is two-sided. Findings above a count fail; findings below it fail too, so fixing',
      'debt means regenerating this file in the same change. That is what keeps the number exact',
      'at every commit instead of exact on the day it was written — and it is why this file needs',
      'no report published beside it. It can only move down.',
      '',
      'Rules are at full strength in biome.json and nothing here demotes any of them. A file with',
      'no entry below must be completely clean.',
      '',
      'THIS FILE IS A DOOR. A diff that ADDS a line here, or RAISES a number, is a finding',
      'entering the tolerated set, and it is reviewed exactly like a suppression: a written reason,',
      'or refusal. Downward travels free. The shape below is nested one-rule-per-line so that an',
      'increase is a single changed line with both numbers on screen — an array of objects hides',
      'an insertion inside its neighbour’s punctuation, and a door nobody can see opening is not a',
      'door.',
    ],
    biome: version,
    total: total(actual),
    entries: toFile(actual),
  }
  writeFileSync(BASELINE, `${JSON.stringify(next, null, 2)}\n`)
  console.log(
    `check-lint-baseline: wrote ${path.relative(ROOT, BASELINE)} — ${actual.length} file/rule pairs, ${total(actual)} findings`,
  )
  process.exit(0)
}

// A baseline written by a different biome is a baseline about a different
// question. Reported rather than silently compared, because the disagreement
// would surface as excess and deficit scattered across unrelated files.
if (baselineFile.biome && baselineFile.biome !== version) {
  die(`the baseline was written by biome ${baselineFile.biome} and this is ${version} — regenerate it deliberately`)
}

const { excess, deficit } = compare(actual, baseline)

if (asJson) {
  console.log(
    JSON.stringify({ biome: version, scanned: verdict.scanned, total: total(actual), excess, deficit }, null, 2),
  )
} else {
  // The block below is EVIDENCE, and it is pasted into a pull request by hand,
  // so it has to say what it ran against. A verdict with no tree attached could
  // have come from anywhere — another branch, another checkout, yesterday. The
  // commit bounds that; the baseline hash says which bar was cleared; the
  // version says which tool decided. One run, one block.
  const failing = excess.length > 0 || deficit.length > 0
  console.log('── check-lint-baseline ─────────────────────────────────────────')
  console.log(`  biome     ${version}`)
  console.log(`  commit    ${describeTree()}`)
  console.log(`  baseline  ${baselineHash} — ${baseline.length} file/rule pairs, ${total(baseline)} findings`)
  console.log(`  scanned   ${verdict.scanned} files, ${total(actual)} findings`)
  console.log(`  verdict   ${failing ? `FAIL — ${excess.length} above, ${deficit.length} below` : 'PASS'}`)
  console.log('────────────────────────────────────────────────────────────────')
  console.log('')
  for (const e of excess) {
    console.log(`  NEW      ${e.file}  ${e.rule}  ${e.allowed} → ${e.actual}`)
  }
  for (const e of deficit) {
    console.log(`  FIXED    ${e.file}  ${e.rule}  ${e.allowed} → ${e.actual}`)
  }
  if (!failing) {
    console.log('  nothing added, nothing fixed-but-unrecorded.')
  } else {
    console.log('')
    if (excess.length > 0) {
      console.log(
        `${excess.length} finding group(s) above the baseline. Every rule is at full strength; fix them or suppress with a reason.`,
      )
    }
    if (deficit.length > 0) {
      console.log(
        `${deficit.length} finding group(s) below the baseline — run \`npm run check -- --update\` and commit it,`,
      )
      console.log('so the number that gates the next change is the one that is true now.')
    }
  }
}

process.exit(excess.length > 0 || deficit.length > 0 ? 1 : 0)

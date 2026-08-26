// Runs the whole workspace suite and reports the DELTA against what is already
// written down, not the state of the tree.
//
// The distinction is the whole point. A check that answers "is everything
// green?" answers "no" on a tree that has any tolerated failure at all, from
// its first day, and a signal that is always red teaches everyone to read past
// it -- which is the condition this exists to end, not one to reproduce. A
// check that answers "did this change make it worse?" is empty by default, so
// anything it prints is new by construction, and it belongs to whoever is
// running it.
//
// What is tolerated lives in test-baseline.json, which is committed. Widening
// it is an edit to a reviewed file with a reason attached; nothing here ever
// writes to it. That is the ratchet: tolerating a failure stays possible and
// stops being free and silent.
//
// Three call sites, one command:
//   - an author, before asking for review -- so "which suites are relevant?"
//     stops being a judgement call that can be answered wrongly
//   - whoever merges, before merging -- the one deliberate step this repo has
//   - a scheduled sweep against the integration branch, which is the only
//     thing that ever sees two changes that are green apart and red together
//
// Known limitation, written down here rather than left to be rediscovered: the
// run is audited against what it reports about itself, so a workspace whose
// test script npm never invokes prints nothing, nothing is expected of it, and
// its absence cannot be seen. Closing that means knowing the workspace list
// independently of the run.
//
// Usage:
//   node scripts/check-baseline.mjs           human-readable, exit 1 on new failures
//   node scripts/check-baseline.mjs --json    same result as JSON on stdout
import { spawnSync } from 'node:child_process'
import { readFileSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

import { auditRun, compare, parseFailures } from './baseline-report.mjs'

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const baselineFile = path.join(repoRoot, 'test-baseline.json')

function readBaseline() {
  const parsed = JSON.parse(readFileSync(baselineFile, 'utf-8'))
  for (const entry of parsed.tolerated) {
    if (!entry.id || !entry.reason) {
      throw new Error(`test-baseline.json: every entry needs an id and a reason; found ${JSON.stringify(entry)}`)
    }
  }
  return parsed.tolerated
}

function runSuite() {
  // Through the workspaces' own test scripts rather than a second way of
  // invoking them, so this can never disagree with what `npm test` does.
  // OPENCROFT_TEST_TAP asks those scripts for machine-readable output; without
  // it a human still gets the reporter they had before.
  const result = spawnSync('npm', ['run', 'test', '--workspaces', '--if-present'], {
    cwd: repoRoot,
    encoding: 'utf-8',
    maxBuffer: 256 * 1024 * 1024,
    env: { ...process.env, OPENCROFT_TEST_TAP: '1' },
  })
  // `status` is null exactly when the child was killed, and folding that into a
  // plain non-zero exit would lose the one signal that says the run is partial
  // rather than finished-and-failing.
  return {
    output: `${result.stdout ?? ''}\n${result.stderr ?? ''}`,
    status: result.status ?? 1,
    signal: result.signal ?? null,
  }
}

const asJson = process.argv.includes('--json')
const known = readBaseline()
const { output, status, signal } = runSuite()
const { failures, reported } = parseFailures(output, repoRoot)

const unreadable = auditRun(output, status, failures.length, reported, signal)
if (unreadable) {
  console.error(`check-baseline could not believe the suite output: ${unreadable}.`)
  console.error('Refusing to report a result from a run it does not understand.')
  process.exit(2)
}

const { added, stale } = compare(failures, known)
// Split before counting them: an entry merely passing HERE is not the same news
// as one that has started passing everywhere, and one total invites someone to
// act on the first as though it were the second.
const elsewhere = stale.filter((entry) => entry.environment)
const gone = stale.filter((entry) => !entry.environment)

if (asJson) {
  console.log(JSON.stringify({ tolerated: known.length, added, stale: gone, environmentDependent: elsewhere }, null, 2))
} else {
  const counts = [`${known.length} tolerated`, `${added.length} new`, `${gone.length} stale`]
  if (elsewhere.length > 0) {
    counts.push(`${elsewhere.length} environment-dependent`)
  }
  console.log(`baseline: ${counts.join(', ')}`)
  for (const failure of added) {
    console.log(`  NEW   ${failure.id}`)
  }
  // Reported, never enforced, and never written. A flaky entry would otherwise
  // flip the run red and green on alternate days over nothing anyone could act
  // on -- and a test that has started passing is the direction this is meant to
  // move in, so failing on it would punish the change that fixed it.
  for (const entry of gone) {
    console.log(`  STALE ${entry.id} -- passing now; delete this entry`)
  }
  // Not stale: passing here and still failing where the entry was written for.
  // Advising anyone to delete one would remove a check that is doing its job.
  for (const entry of elsewhere) {
    console.log(`  ENV   ${entry.id} -- passing here; ${entry.environment}`)
  }
}

process.exit(added.length > 0 ? 1 : 0)

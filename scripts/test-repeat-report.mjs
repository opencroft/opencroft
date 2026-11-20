// What scripts/test-repeat.mjs makes of its runs: each run's TAP report read
// into per-test results, each run given one outcome, and a file's runs
// summed up into the one line it prints. No I/O, so the rules are tested
// without running anything.

/**
 * Failure types that are not a verdict on the test they are reported for: a
 * suite fails when one of its tests does, and a test still running when its
 * file timed out is cancelled by its parent.
 */
const NOT_A_VERDICT = new Set(['subtestsFailed', 'cancelledByParent'])

/**
 * Reads a TAP report of one test file as node's test runner writes it, into
 * a map of each test to 'pass' or 'fail', keyed by its path of suite and test
 * names joined with " > ". A second test of the same path in one report is
 * keyed "<path> (2)", and so on, so two tests that share a name are never
 * counted as one. Skipped and todo tests are left out.
 *
 * A file that declares no test is reported as a passing test named by the
 * path the runner was given, `file`; that entry is left out too, so such a
 * run reads as having run nothing.
 */
export function readTap(text, file) {
  const results = new Map()
  const seen = new Map()
  const path = []
  const lines = text.split('\n')
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]
    let m = line.match(/^( *)# Subtest: (.*)$/)
    if (m) {
      const depth = m[1].length / 4
      path.length = depth
      path[depth] = m[2]
      continue
    }
    m = line.match(/^( *)(not ok|ok) \d+ - (.*)$/)
    if (m) {
      if (/ # (?:SKIP|TODO)\b/i.test(m[3])) continue
      const depth = m[1].length / 4
      if (depth === 0 && m[3] === file) continue
      const passed = m[2] === 'ok'
      if (!passed && NOT_A_VERDICT.has(failureType(lines, i))) continue
      const name = [...path.slice(0, depth), m[3]].join(' > ')
      const count = (seen.get(name) ?? 0) + 1
      seen.set(name, count)
      results.set(count === 1 ? name : `${name} (${count})`, passed ? 'pass' : 'fail')
    }
  }
  return results
}

/** The `failureType` in the YAML block that follows the result on line `at`. */
function failureType(lines, at) {
  for (let j = at + 1; j < lines.length; j++) {
    const text = lines[j].trim()
    if (text === '...') break
    const m = text.match(/^failureType: '(\w+)'$/)
    if (m) return m[1]
  }
  return ''
}

/**
 * One run's outcome, from its exit code, whether the runner timed it out,
 * and its results as `readTap` reads them:
 * - 'timeout': the runner killed the file at its limit, whatever else it
 *   reported;
 * - 'empty': it exited 0 without running a test, which is not a pass;
 * - 'pass': it exited 0 having run at least one test;
 * - 'fail': anything else.
 */
export function runOutcome({ exitCode, timedOut, results }) {
  if (timedOut) return 'timeout'
  if (exitCode === 0) return results.size > 0 ? 'pass' : 'empty'
  return 'fail'
}

/**
 * Sums up one file's runs, each `{ outcome, results }`. A test that passed
 * in some runs and failed in others flipped; one that failed in every run
 * that reported it, and never passed, is listed apart, since repeating it
 * says nothing about flakiness.
 */
export function summarise(file, runs) {
  const count = (outcome) => runs.filter((run) => run.outcome === outcome).length
  const tally = new Map()
  for (const run of runs) {
    for (const [name, result] of run.results) {
      const entry = tally.get(name) ?? { pass: 0, fail: 0 }
      entry[result] += 1
      tally.set(name, entry)
    }
  }
  const flipped = []
  const alwaysFailed = []
  for (const [name, { pass, fail }] of tally) {
    if (fail === 0) continue
    if (pass > 0) flipped.push({ name, failed: fail, of: pass + fail })
    else alwaysFailed.push(name)
  }
  return {
    file,
    runs: runs.length,
    passes: count('pass'),
    failures: count('fail'),
    timeouts: count('timeout'),
    empty: count('empty'),
    flipped,
    alwaysFailed,
  }
}

/**
 * The summary as one line, led by a verdict: `stable` when every run passed,
 * `failing` when none did, `flaky` in between.
 */
export function formatSummary(summary) {
  const { file, runs, passes, failures, timeouts, empty, flipped, alwaysFailed } = summary
  const verdict = passes === runs ? 'stable' : passes === 0 ? 'failing' : 'flaky'
  let line = `${verdict} ${file}: ${runs} runs, ${passes} passed, ${failures} failed, ${timeouts} timed out`
  if (empty > 0) line += `, ${empty} ran no tests`
  if (flipped.length > 0) {
    line += `; flipped: ${flipped.map(({ name, failed, of }) => `"${name}" (failed ${failed} of ${of})`).join(', ')}`
  }
  if (alwaysFailed.length > 0) {
    line += `; failed every run: ${alwaysFailed.map((name) => `"${name}"`).join(', ')}`
  }
  return line
}

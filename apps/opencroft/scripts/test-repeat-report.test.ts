// How the flake detector (scripts/test-repeat.mjs) reads a run's TAP report,
// gives a run its outcome and sums up a file's runs. The reports are written
// in the shape node's tap reporter gives them; test-repeat.test.ts runs the
// tool over real reports.

import assert from 'node:assert/strict'
import test from 'node:test'

import { formatSummary, readTap, runOutcome, summarise } from '../../../scripts/test-repeat-report.mjs'

/** A result line with its YAML block, at `depth` levels of nesting. */
function result(depth: number, n: number, ok: boolean, name: string, failureType?: string): string {
  const pad = '    '.repeat(depth)
  const yaml = [`${pad}  ---`, `${pad}  duration_ms: 1.5`]
  if (failureType) yaml.push(`${pad}  failureType: '${failureType}'`, `${pad}  error: 'boom'`)
  yaml.push(`${pad}  ...`)
  return [`${pad}# Subtest: ${name}`, `${pad}${ok ? 'ok' : 'not ok'} ${n} - ${name}`, ...yaml].join('\n')
}

function report(lines: string[], tests: number): string {
  return ['TAP version 13', ...lines, `1..${lines.length}`, `# tests ${tests}`].join('\n')
}

const nested = report(
  [
    [
      '# Subtest: outer',
      result(1, 1, true, 'passes'),
      result(1, 2, false, 'fails', 'testCodeFailure'),
      result(1, 3, false, 'was running at the limit', 'cancelledByParent'),
      '    1..3',
      'not ok 1 - outer',
      "  ---\n  type: 'suite'\n  failureType: 'subtestsFailed'\n  ...",
    ].join('\n'),
    result(0, 2, false, 'over its own timeout', 'testTimeoutFailure'),
    result(0, 3, true, 'skipped # SKIP no binary'),
    result(0, 4, true, 'same name'),
    result(0, 5, false, 'same name', 'testCodeFailure'),
  ],
  6,
)

test('a report is read into one result per test, keyed by its suite path', () => {
  assert.deepEqual(Object.fromEntries(readTap(nested, 'src/a.test.ts')), {
    'outer > passes': 'pass',
    'outer > fails': 'fail',
    'over its own timeout': 'fail',
    'same name': 'pass',
    'same name (2)': 'fail',
  })
})

test('the entry for a file that declares no test is not read as a test', () => {
  const declaresNone = report([result(0, 1, true, 'src/a.test.ts')], 1)
  assert.deepEqual(Object.fromEntries(readTap(declaresNone, 'src/a.test.ts')), {})
  // Only the file's own entry: a test that happens to share the name of
  // another file is still a test.
  assert.deepEqual(Object.fromEntries(readTap(declaresNone, 'src/b.test.ts')), { 'src/a.test.ts': 'pass' })
})

test('a run gets one outcome, a timeout first', () => {
  const ran = new Map([['a', 'pass']])
  const none = new Map()
  const cases = [
    { name: 'clean exit with tests', run: { exitCode: 0, timedOut: false, results: ran }, outcome: 'pass' },
    { name: 'clean exit, no tests', run: { exitCode: 0, timedOut: false, results: none }, outcome: 'empty' },
    { name: 'failed exit', run: { exitCode: 1, timedOut: false, results: ran }, outcome: 'fail' },
    { name: 'failed exit, no report', run: { exitCode: 1, timedOut: false, results: none }, outcome: 'fail' },
    { name: 'killed at the limit', run: { exitCode: 1, timedOut: true, results: ran }, outcome: 'timeout' },
    { name: 'killed by a signal', run: { exitCode: null, timedOut: false, results: none }, outcome: 'fail' },
  ]
  for (const { name, run, outcome } of cases) {
    assert.equal(runOutcome(run), outcome, name)
  }
})

function run(outcome: string, results: Record<string, 'pass' | 'fail'>) {
  return { outcome, results: new Map(Object.entries(results)) }
}

test('a test with mixed results flipped; one that never passed is listed apart', () => {
  const summary = summarise('a.test.ts', [
    run('pass', { steady: 'pass', wobbly: 'pass' }),
    run('fail', { steady: 'pass', wobbly: 'fail', broken: 'fail' }),
    run('fail', { steady: 'pass', wobbly: 'pass', broken: 'fail' }),
    run('timeout', { steady: 'pass' }),
  ])
  assert.deepEqual(summary, {
    file: 'a.test.ts',
    runs: 4,
    passes: 1,
    failures: 2,
    timeouts: 1,
    empty: 0,
    flipped: [{ name: 'wobbly', failed: 1, of: 3 }],
    alwaysFailed: ['broken'],
  })
  assert.equal(
    formatSummary(summary),
    'flaky a.test.ts: 4 runs, 1 passed, 2 failed, 1 timed out; flipped: "wobbly" (failed 1 of 3); failed every run: "broken"',
  )
})

test('the verdict is stable only when every run passed, failing when none did', () => {
  const cases = [
    { outcomes: ['pass', 'pass'], line: 'stable f.test.ts: 2 runs, 2 passed, 0 failed, 0 timed out' },
    { outcomes: ['pass', 'empty'], line: 'flaky f.test.ts: 2 runs, 1 passed, 0 failed, 0 timed out, 1 ran no tests' },
    { outcomes: ['timeout', 'fail'], line: 'failing f.test.ts: 2 runs, 0 passed, 1 failed, 1 timed out' },
  ]
  for (const { outcomes, line } of cases) {
    const summary = summarise(
      'f.test.ts',
      outcomes.map((outcome) => run(outcome, {})),
    )
    assert.equal(formatSummary(summary), line, outcomes.join(','))
  }
})

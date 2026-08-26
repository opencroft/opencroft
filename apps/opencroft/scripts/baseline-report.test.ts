// The reader half of the workspace-wide baseline check, which lives at the
// repository root because it is not this app's tool. Its tests live here
// because this is where tooling tests already run — and because the baseline
// check runs the workspaces' own suites, which means keeping them here is what
// makes the check verify its own reader every time it is used.
//
// What is pinned is IDENTITY. The check's other guard compares counts, and a
// reader that extracts the right number of the wrong identities satisfies it on
// every real run — while quietly filing a failure under a name that is already
// tolerated, which is the one outcome this whole tool exists to prevent.
import assert from 'node:assert/strict'
import test from 'node:test'

import { auditRun, compare, identify, parseFailures } from '../../../scripts/baseline-report.mjs'

const ROOT = '/repo'

// `entries` are TAP lines, of which only some are failures — the totals line
// has to count the failures, not the lines, or the fixture disagrees with
// itself and the parse looks wrong when it is right.
function tapFor(entries: string[]): string {
  const failed = entries.filter((line) => line.startsWith('not ok')).length
  return ['> pkg@1.0.0 test', 'Found 3 test files.', ...entries, `# fail ${failed}`].join('\n')
}

test('a failing test is identified by its file and its name together', () => {
  const { failures, reported } = parseFailures(
    tapFor([
      'not ok 4 - refuses a payload that does not state queue',
      '  ---',
      "  location: '/repo/apps/app/src/helpers.test.ts:57:1'",
      '  ...',
    ]),
    ROOT,
  )

  assert.equal(reported, 1)
  assert.deepEqual(
    failures.map((f) => f.id),
    ['apps/app/src/helpers.test.ts :: refuses a payload that does not state queue'],
  )
})

test('a file that fails to load is identified by the file alone, not twice over', () => {
  // Node reports the file as the name, relative to its workspace, while the
  // location is absolute — the same thing written two ways.
  const { failures } = parseFailures(
    tapFor([
      'not ok 2 - src/components/agent-command-bar.test.ts',
      '  ---',
      "  location: '/repo/packages/chat/src/components/agent-command-bar.test.ts:1:1'",
      '  ...',
    ]),
    ROOT,
  )

  assert.deepEqual(
    failures.map((f) => f.id),
    ['packages/chat/src/components/agent-command-bar.test.ts'],
  )
})

test('a test whose name merely ends the file path keeps its own identity', () => {
  // The collapse above is a path-boundary match, not a suffix match. Every
  // `.ts` file ends with `ts`, so a suffix test would hand this failure the id
  // reserved for its whole file failing to load — where a tolerated load
  // failure would then absorb it and report nothing.
  const { failures } = parseFailures(
    tapFor(['not ok 7 - ts', '  ---', "  location: '/repo/apps/app/src/thing.test.ts:12:3'", '  ...']),
    ROOT,
  )

  assert.deepEqual(
    failures.map((f) => f.id),
    ['apps/app/src/thing.test.ts :: ts'],
  )
})

test('a location quoted inside a failure message does not displace the real one', () => {
  // An error's own text can carry a line shaped exactly like the diagnostic,
  // and taking the last match would identify the file the failure touched
  // rather than the file the test lives in — a wrong id that still looks right.
  const { failures } = parseFailures(
    tapFor([
      'not ok 9 - the reader resolves every chunk it imports',
      '  ---',
      "  location: '/repo/apps/app/src/race.test.ts:88:1'",
      '  error: |-',
      "    location: '/repo/apps/app/src/somewhere-else.ts:1:1'",
      '  ...',
    ]),
    ROOT,
  )

  assert.deepEqual(
    failures.map((f) => f.id),
    ['apps/app/src/race.test.ts :: the reader resolves every chunk it imports'],
  )
})

test('identify collapses only on a whole path segment', () => {
  assert.equal(identify('a/b/thing.test.ts', 'thing.test.ts'), 'a/b/thing.test.ts')
  assert.equal(identify('a/b/thing.test.ts', 'a/b/thing.test.ts'), 'a/b/thing.test.ts')
  assert.equal(identify('a/b/thing.test.ts', 'ts'), 'a/b/thing.test.ts :: ts')
  assert.equal(identify('a/b/thing.test.ts', 'test.ts'), 'a/b/thing.test.ts :: test.ts')
})

test('compare separates what is new from what is no longer failing', () => {
  const { added, stale } = compare(
    [{ id: 'a :: one' }, { id: 'b :: two' }],
    [
      { id: 'b :: two', reason: 'known' },
      { id: 'c :: three', reason: 'fixed since' },
    ],
  )

  assert.deepEqual(
    added.map((f) => f.id),
    ['a :: one'],
  )
  assert.deepEqual(
    stale.map((e) => e.id),
    ['c :: three'],
  )
})

// One workspace, one file, no failures — a believable run, which each case
// below breaks in exactly one way.
const CLEAN = ['> a@1.0.0 test', 'Found 2 test files.', '# fail 0'].join('\n')

test('a run that produced nothing is refused rather than read as clean', () => {
  // The shape total failure takes: no output, so nothing to disagree with, so
  // every count matches at zero and every tolerated entry looks obsolete.
  assert.match(auditRun('', 1, 0, 0) ?? '', /no workspace reported running/)
})

test('a workspace that died before listing its files is refused', () => {
  const output = [CLEAN, '> b@1.0.0 test'].join('\n')
  assert.match(auditRun(output, 1, 0, 0) ?? '', /2 workspaces started .* but 1 reported/)
})

test('a suite with files that reported no totals is refused', () => {
  const output = ['> a@1.0.0 test', 'Found 2 test files.'].join('\n')
  assert.match(auditRun(output, 1, 0, 0) ?? '', /1 suites had test files but 0 reported totals/)
})

test('a suite with no test files at all is expected to report no totals', () => {
  // A workspace can declare a test script and own no test files; its runner
  // exits before producing any. Pairing totals against workspaces rather than
  // against suites that HAVE files would fail every clean run.
  const output = [CLEAN, '> b@1.0.0 test', 'Found 0 test files.'].join('\n')
  assert.equal(auditRun(output, 0, 0, 0), null)
})

test('a parse that read fewer failures than the suites counted is refused', () => {
  const output = ['> a@1.0.0 test', 'Found 2 test files.', '# fail 3'].join('\n')
  assert.match(auditRun(output, 1, 1, 3) ?? '', /reported 3 failures and 1 were extracted/)
})

test('a failed run with nothing extracted is refused even when the counts agree', () => {
  assert.match(auditRun(CLEAN, 1, 0, 0) ?? '', /exited 1 with no failure extracted/)
})

test('a killed run is refused even though everything it did report agrees', () => {
  // The partial run every other check passes: whatever finished started,
  // listed and totalled, and its failures extract cleanly, so the delta would
  // be computed over however much ran before the process died. Only the signal
  // says the run was cut short — the output cannot.
  const output = ['> a@1.0.0 test', 'Found 2 test files.', '# fail 4'].join('\n')
  assert.match(auditRun(output, 1, 4, 4, 'SIGKILL') ?? '', /killed by SIGKILL/)
})

test('a believable run is not refused', () => {
  assert.equal(auditRun(CLEAN, 0, 0, 0, null), null)
})

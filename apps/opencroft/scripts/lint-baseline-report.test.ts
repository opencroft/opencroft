// The reader half of the biome baseline gate, which lives at the repository
// root because it is not this app's tool. Its tests live here for the same
// reason the workspace baseline's do: this is where tooling tests already run.
//
// What is pinned is IDENTITY and DIRECTION. A reader that extracts the right
// number of the wrong identities satisfies any count check on every real run,
// while filing a finding under a name that is already allowed — which is the
// one outcome the gate exists to prevent. And a comparison that is right about
// excess and wrong about deficit looks correct on every day except the one
// where somebody fixes something.
//
// The run-believability branches are tested against shapes a real run is least
// likely to produce, because those are the shapes that decide whether a broken
// run can pass as a clean one.
import assert from 'node:assert/strict'
import test from 'node:test'

import {
  aggregate,
  compare,
  coverageVerdict,
  fromFile,
  keyOf,
  toFile,
  total,
  validateRun,
} from '../../../scripts/lint-baseline-report.mjs'

const at = (path: string, category: string) => ({
  severity: 'error',
  category,
  location: { path },
  message: 'x',
  advices: [],
})

const summary = (over: Record<string, number> = {}) => ({
  changed: 0,
  unchanged: 860,
  errors: 1,
  warnings: 0,
  infos: 0,
  diagnosticsNotPrinted: 0,
  ...over,
})

test('findings are counted per file AND per rule, not per file', () => {
  // Two rules in one file are two entries. Collapsing them to one file-level
  // count would let a fixed finding of one rule pay for a new finding of
  // another, in the same file, and the gate would see nothing.
  const { entries } = aggregate([
    at('a.ts', 'lint/suspicious/noArrayIndexKey'),
    at('a.ts', 'lint/suspicious/noArrayIndexKey'),
    at('a.ts', 'format'),
    at('b.ts', 'format'),
  ])

  assert.deepEqual(entries, [
    { file: 'a.ts', rule: 'format', count: 1 },
    { file: 'a.ts', rule: 'lint/suspicious/noArrayIndexKey', count: 2 },
    { file: 'b.ts', rule: 'format', count: 1 },
  ])
})

test('a path containing a space keeps its own identity', () => {
  // The key joins a file and a rule. Built with an ordinary separator and read
  // back with a split, this path is filed under a truncated name — silently,
  // and only for the paths that happen to contain one.
  const { entries } = aggregate([at('apps/my app/x.ts', 'lint/style/useTemplate')])

  assert.deepEqual(entries, [{ file: 'apps/my app/x.ts', rule: 'lint/style/useTemplate', count: 1 }])
})

test('a diagnostic with no file or no rule is counted as unreadable, never dropped', () => {
  // Dropping one is a false green: it leaves the actuals, the comparison sees
  // a deficit or nothing, and nothing says why.
  const { entries, unreadable } = aggregate([
    at('a.ts', 'format'),
    { severity: 'error', category: 'format', location: {}, message: 'x' },
    { severity: 'error', location: { path: 'b.ts' }, message: 'x' },
  ])

  assert.equal(unreadable, 2)
  assert.deepEqual(entries, [{ file: 'a.ts', rule: 'format', count: 1 }])
})

test('more of a finding than the baseline allows is excess', () => {
  const { excess, deficit } = compare(
    [{ file: 'a.ts', rule: 'format', count: 3 }],
    [{ file: 'a.ts', rule: 'format', count: 2 }],
  )

  assert.deepEqual(excess, [{ file: 'a.ts', rule: 'format', allowed: 2, actual: 3 }])
  assert.deepEqual(deficit, [])
})

test('a file with no baseline entry has to be completely clean', () => {
  // This is what holds new code to full strength: absence means zero, not
  // "unknown, allow it".
  const { excess } = compare([{ file: 'new.ts', rule: 'lint/a11y/useButtonType', count: 1 }], [])

  assert.deepEqual(excess, [{ file: 'new.ts', rule: 'lint/a11y/useButtonType', allowed: 0, actual: 1 }])
})

test('FEWER findings than the baseline allows is also a failure', () => {
  // The half that is easy to leave out, and the reason the gate is two-sided.
  // An entry of 2 over an actual 1 is a licence: the next instance of that
  // rule in that file lands green against the written number.
  const { excess, deficit } = compare(
    [{ file: 'a.ts', rule: 'format', count: 1 }],
    [{ file: 'a.ts', rule: 'format', count: 2 }],
  )

  assert.deepEqual(deficit, [{ file: 'a.ts', rule: 'format', allowed: 2, actual: 1 }])
  assert.deepEqual(excess, [])
})

test('a baseline entry whose findings are all gone is a deficit, not silence', () => {
  const { deficit } = compare([], [{ file: 'a.ts', rule: 'format', count: 1 }])

  assert.deepEqual(deficit, [{ file: 'a.ts', rule: 'format', allowed: 1, actual: 0 }])
})

test('matching exactly is the only clean answer', () => {
  const { excess, deficit } = compare(
    [{ file: 'a.ts', rule: 'format', count: 2 }],
    [{ file: 'a.ts', rule: 'format', count: 2 }],
  )

  assert.deepEqual(excess, [])
  assert.deepEqual(deficit, [])
})

test('the total is the debt number the baseline reports', () => {
  assert.equal(total([{ count: 2 }, { count: 3 }]), 5)
  assert.equal(total([]), 0)
  assert.equal(total(undefined), 0)
})

test('the written form puts one rule on one line, so an increase is one changed line', () => {
  // The file is a door: an added or raised entry is a finding entering the
  // tolerated set and is reviewed like a suppression. That review only works
  // if the reviewer can see it at a glance, which is a property of the SHAPE
  // rather than of anyone's diligence.
  const written = toFile([
    { file: 'b.ts', rule: 'format', count: 1 },
    { file: 'a.ts', rule: 'lint/style/useTemplate', count: 3 },
    { file: 'a.ts', rule: 'format', count: 2 },
  ])

  assert.deepEqual(written, {
    'a.ts': { format: 2, 'lint/style/useTemplate': 3 },
    'b.ts': { format: 1 },
  })
  // Sorted, so the file is stable and a diff shows only what actually moved.
  assert.deepEqual(Object.keys(written), ['a.ts', 'b.ts'])
})

test('the written form round-trips without losing or inventing a finding', () => {
  const entries = [
    { file: 'a.ts', rule: 'format', count: 2 },
    { file: 'a.ts', rule: 'lint/style/useTemplate', count: 3 },
    { file: 'my dir/b.ts', rule: 'format', count: 1 },
  ]

  const { entries: back, malformed } = fromFile(toFile(entries))

  assert.equal(malformed, 0)
  assert.deepEqual(back, entries)
  assert.equal(total(back), total(entries))
})

test('a baseline entry that cannot be read is counted, never treated as zero', () => {
  // Treating it as zero LOWERS the bar silently — the gate would then report
  // the real findings as excess, or worse, accept a hand-edit that removed a
  // count by corrupting it.
  const { entries, malformed } = fromFile({
    'a.ts': { format: 2 },
    'b.ts': { format: 'lots' },
    'c.ts': { format: 0 },
    'd.ts': null,
  })

  assert.deepEqual(entries, [{ file: 'a.ts', rule: 'format', count: 2 }])
  assert.equal(malformed, 3)
})

test('a run that scanned nothing is refused', () => {
  // It ran, it exited, and it looked at no files. By exit code this is
  // indistinguishable from a healthy run.
  const v = validateRun({ summary: summary({ unchanged: 0 }), diagnostics: [] }, { unreadable: 0, baselineEntries: 5 })

  assert.equal(v.ok, false)
  assert.match(v.reason, /scanned no files/)
})

test('a run whose diagnostics were withheld is refused', () => {
  // A capped run produces a smaller, entirely well-formed actuals list, which
  // would ratchet the baseline downward for a reason that has nothing to do
  // with the code.
  const v = validateRun(
    { summary: summary({ diagnosticsNotPrinted: 12 }), diagnostics: [at('a.ts', 'format')] },
    { unreadable: 0, baselineEntries: 5 },
  )

  assert.equal(v.ok, false)
  assert.match(v.reason, /withheld/)
})

test('zero findings while the baseline is not empty is refused', () => {
  // "Nothing found" and "nothing ran" must not share an answer.
  const v = validateRun({ summary: summary(), diagnostics: [] }, { unreadable: 0, baselineEntries: 412 })

  assert.equal(v.ok, false)
  assert.match(v.reason, /broken run, not a clean tree/)
})

test('zero findings IS believable once the baseline is empty', () => {
  // The finished state has to be reachable, or the gate can never be satisfied
  // and becomes the thing it replaced.
  const v = validateRun({ summary: summary({ errors: 0 }), diagnostics: [] }, { unreadable: 0, baselineEntries: 0 })

  assert.equal(v.ok, true)
})

test('an unreadable diagnostic refuses the whole run', () => {
  const v = validateRun(
    { summary: summary(), diagnostics: [at('a.ts', 'format')] },
    { unreadable: 1, baselineEntries: 5 },
  )

  assert.equal(v.ok, false)
  assert.match(v.reason, /could not be counted/)
})

test('output that is not a biome run at all is refused, in each shape', () => {
  for (const [what, parsed] of [
    ['nothing', null],
    ['no summary', { diagnostics: [] }],
    ['no diagnostics array', { summary: summary() }],
  ] as const) {
    const v = validateRun(parsed, { unreadable: 0, baselineEntries: 5 })
    assert.equal(v.ok, false, `${what} should refuse the run`)
  }
})

// ── How much of the tree the run looked at ────────────────────────────────
//
// The hole the two-sided comparison cannot see: a path excluded from biome's
// config contributes findings to neither side, so excluding a CLEAN path is
// invisible to both excess and deficit. Direction is the whole of this guard —
// a check that refused growth as well would fail every time a file was added.

test('a run that scanned fewer files than the baseline was measured over is refused', () => {
  const v = coverageVerdict(867, 870)

  assert.equal(v.ok, false)
  // Both causes, because nothing here can tell them apart and guessing sends
  // the reader to the wrong one.
  assert.match(v.reason, /deleted/)
  assert.match(v.reason, /excluded/)
})

test('scanning MORE is free — files get added, and that is not a narrowing', () => {
  assert.equal(coverageVerdict(871, 870).ok, true)
  assert.equal(coverageVerdict(870, 870).ok, true)
})

test('a baseline that records no coverage at all is refused, not waved through', () => {
  // "Nothing written down" and "nothing to write down" arrive as the same
  // absent field. Reading the absence as a pass would make deleting one line
  // the way to disarm this.
  for (const [what, recorded] of [
    ['absent', undefined],
    ['null', null],
    ['zero', 0],
    ['not a number', '870'],
  ] as const) {
    assert.equal(coverageVerdict(870, recorded).ok, false, `a ${what} coverage count should refuse the run`)
  }
})

test('the key separator is a character no path or rule can contain', () => {
  // Pinned because the spelling changed — the byte was written literally once,
  // which classified the file as binary and made every future diff of it
  // unreviewable on the forge. What matters is the runtime string, not how it
  // is spelled, so this asserts the string.
  const key = keyOf('a', 'b')
  assert.equal(key.length, 3, 'the separator is exactly one character')
  assert.equal(key.charCodeAt(1), 0, 'and it is NUL, which no path and no rule name can contain')
})

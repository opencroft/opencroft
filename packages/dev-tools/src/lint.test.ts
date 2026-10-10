// Reading a biome JSON report into the lint verdict.
//
// What is pinned is BELIEVABILITY: every shape tested here is one a broken run
// can produce while exiting the way a healthy one does, so each must be
// refused rather than read as a clean tree.
import assert from 'node:assert/strict'
import test from 'node:test'

import { readRun } from './lint.mjs'

const at = (path: string, category: string, line = 1, column = 1) => ({
  severity: 'error',
  category,
  message: 'x',
  location: { path, start: { line, column }, end: { line, column: column + 1 } },
  advices: [],
})

const summary = (over: Record<string, number> = {}) => ({
  changed: 0,
  unchanged: 860,
  errors: 0,
  warnings: 0,
  infos: 0,
  diagnosticsNotPrinted: 0,
  ...over,
})

test('a run with no diagnostics over scanned files is clean', () => {
  const v = readRun({ summary: summary(), diagnostics: [] })
  assert.deepEqual(v, { ok: true, scanned: 860, findings: [] })
})

test('every diagnostic is a finding with its place, sorted by file, line and column', () => {
  const v = readRun({
    summary: summary({ errors: 3 }),
    diagnostics: [
      at('b.ts', 'format'),
      at('a.ts', 'lint/style/useTemplate', 9, 3),
      at('a.ts', 'lint/suspicious/noArrayIndexKey', 2, 7),
    ],
  })
  assert.equal(v.ok, true)
  assert.deepEqual(
    v.ok &&
      v.findings.map((f: { file: string; line: number; column: number; rule: string }) => [
        f.file,
        f.line,
        f.column,
        f.rule,
      ]),
    [
      ['a.ts', 2, 7, 'lint/suspicious/noArrayIndexKey'],
      ['a.ts', 9, 3, 'lint/style/useTemplate'],
      ['b.ts', 1, 1, 'format'],
    ],
  )
})

test('a formatting finding has no position, and is still a finding', () => {
  const v = readRun({
    summary: summary({ errors: 1 }),
    diagnostics: [
      { severity: 'error', category: 'format', message: 'x', location: { path: 'a.ts' } },
      {
        severity: 'error',
        category: 'format',
        message: 'x',
        location: { path: 'b.ts', start: { line: 0, column: 0 } },
      },
    ],
  })
  assert.deepEqual(v.ok && v.findings, [
    { file: 'a.ts', line: null, column: null, rule: 'format', message: 'x' },
    { file: 'b.ts', line: null, column: null, rule: 'format', message: 'x' },
  ])
})

test('an info-level diagnostic is a finding like any other', () => {
  const v = readRun({
    summary: summary({ infos: 1 }),
    diagnostics: [{ ...at('a.ts', 'lint/style/useTemplate'), severity: 'info' }],
  })
  assert.equal(v.ok && v.findings.length, 1)
})

test('a run that scanned nothing is refused', () => {
  const v = readRun({ summary: summary({ unchanged: 0 }), diagnostics: [] })
  assert.equal(v.ok, false)
  assert.match(!v.ok ? v.reason : '', /scanned no files/)
})

test('a run whose diagnostics were withheld is refused', () => {
  const v = readRun({ summary: summary({ diagnosticsNotPrinted: 3 }), diagnostics: [at('a.ts', 'format')] })
  assert.equal(v.ok, false)
  assert.match(!v.ok ? v.reason : '', /withheld 3/)
})

test('a diagnostic with no file or no rule refuses the whole run, never dropped', () => {
  const v = readRun({
    summary: summary({ errors: 2 }),
    diagnostics: [at('a.ts', 'format'), { severity: 'error', category: 'format', location: {} }],
  })
  assert.equal(v.ok, false)
  assert.match(!v.ok ? v.reason : '', /1 diagnostic\(s\) carried no file or rule/)
})

test('output that is not a biome run at all is refused, in each shape', () => {
  for (const parsed of [null, 'text', {}, { summary: summary() }, { diagnostics: [] }]) {
    assert.equal(readRun(parsed).ok, false, JSON.stringify(parsed))
  }
})

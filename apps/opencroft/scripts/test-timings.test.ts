// The per-test times a run records and the slowest-tests list it ends with
// (scripts/test-timings.mjs). That a root run prints the list last is in
// run-workspace-tests.test.ts.

import assert from 'node:assert/strict'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import test from 'node:test'

import timingsReporter, { formatSlowest, readTimings, slowestTests } from '../../../scripts/test-timings.mjs'

interface Timing {
  file: string
  name: string
  ms: number
}

async function report(events: object[]): Promise<Timing[]> {
  async function* source() {
    yield* events
  }
  const lines: string[] = []
  for await (const line of timingsReporter(source())) lines.push(line)
  return lines.map((line) => JSON.parse(line))
}

const FILE = resolve('src/a.test.ts')

function finished(type: 'test:pass' | 'test:fail', name: string, details: object, file = FILE) {
  return { type, data: { name, file, nesting: 0, details } }
}

test('the reporter records each finished test, passed or failed, nested ones included', async () => {
  const timings = await report([
    { type: 'test:start', data: { name: 'one', file: FILE } },
    finished('test:pass', 'one', { type: 'test', duration_ms: 12 }),
    finished('test:fail', 'two', { type: 'test', duration_ms: 30 }),
    { type: 'test:pass', data: { name: 'inner', file: FILE, nesting: 1, details: { type: 'test', duration_ms: 4 } } },
  ])

  assert.deepEqual(timings, [
    { file: FILE, name: 'one', ms: 12 },
    { file: FILE, name: 'two', ms: 30 },
    { file: FILE, name: 'inner', ms: 4 },
  ])
})

test('the reporter leaves out suites and the stand-in for a whole file that failed or timed out', async () => {
  const timings = await report([
    finished('test:pass', 'a suite', { type: 'suite', duration_ms: 500 }),
    // A file that failed to load, exited early or hit its limit is reported
    // as one test named after its path, relative to where the run started.
    finished('test:fail', 'src/a.test.ts', { type: 'test', duration_ms: 240_000 }),
    finished('test:pass', 'kept', { type: 'test', duration_ms: 1 }),
  ])

  assert.deepEqual(
    timings.map((timing) => timing.name),
    ['kept'],
  )
})

test('the slowest come first, as many as asked, ties in file and then name order', () => {
  const records = [
    { file: '/r/b.test.ts', name: 'x', ms: 50 },
    { file: '/r/a.test.ts', name: 'y', ms: 50 },
    { file: '/r/a.test.ts', name: 'x', ms: 50 },
    { file: '/r/c.test.ts', name: 'fast', ms: 1 },
    { file: '/r/c.test.ts', name: 'slowest', ms: 900 },
  ]

  assert.deepEqual(slowestTests(records, 4), [
    { file: '/r/c.test.ts', name: 'slowest', ms: 900 },
    { file: '/r/a.test.ts', name: 'x', ms: 50 },
    { file: '/r/a.test.ts', name: 'y', ms: 50 },
    { file: '/r/b.test.ts', name: 'x', ms: 50 },
  ])
  assert.equal(slowestTests(records, 10).length, 5, 'fewer records than asked for: all of them')
})

test('the list gives seconds, the file relative to the root, and the test name', () => {
  const text = formatSlowest(
    [
      { file: '/repo/apps/x/a.test.ts', name: 'imports the world', ms: 61_234 },
      { file: '/repo/packages/y/b.test.ts', name: 'quick', ms: 40 },
    ],
    '/repo',
  )

  assert.equal(
    text,
    [
      'Slowest 2 tests:',
      '  61.2 s  apps/x/a.test.ts > imports the world',
      '   0.0 s  packages/y/b.test.ts > quick',
      '',
    ].join('\n'),
  )
  assert.equal(formatSlowest([], '/repo'), 'Slowest tests: none were timed.\n')
})

test("every workspace's file in the directory is read back", (t) => {
  const dir = mkdtempSync(join(tmpdir(), 'test-timings-'))
  t.after(() => rmSync(dir, { recursive: true, force: true }))
  writeFileSync(join(dir, '1.jsonl'), `${JSON.stringify({ file: 'a', name: 'one', ms: 1 })}\n`)
  writeFileSync(
    join(dir, '2.jsonl'),
    `${JSON.stringify({ file: 'b', name: 'two', ms: 2 })}\n${JSON.stringify({ file: 'b', name: 'three', ms: 3 })}\n`,
  )
  writeFileSync(join(dir, 'other.txt'), 'not a timings file')

  const names = readTimings(dir)
    .map((record: Timing) => record.name)
    .sort()

  assert.deepEqual(names, ['one', 'three', 'two'])
})

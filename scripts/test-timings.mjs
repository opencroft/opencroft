// How long each test took, and the slowest of them at the end of a root run.
//
// The default export is a node:test reporter. run-tests.mjs adds it beside the
// report the run prints when OPENCROFT_TEST_TIMINGS names a directory, and it
// writes one JSON line per finished test to a file there. The root run
// (run-workspace-tests.mjs) gives every workspace the same directory, reads
// the lines back once all of them have finished, and prints the slowest.

import { readdirSync, readFileSync } from 'node:fs'
import { join, relative, resolve } from 'node:path'

/**
 * The reporter: one `{ file, name, ms }` line per passed or failed test.
 *
 * Suites are left out: a suite's time is the sum of its tests, which are
 * listed themselves. So is the stand-in the test runner reports for a whole
 * file that failed to load, exited early or was stopped at its time limit,
 * named after the file's path: its time is the file's, not any test's.
 */
export default async function* timingsReporter(source) {
  for await (const event of source) {
    if (event.type !== 'test:pass' && event.type !== 'test:fail') continue
    const { name, file, details } = event.data
    if (details?.type === 'suite' || typeof details?.duration_ms !== 'number') continue
    if (file && resolve(name) === file) continue
    yield `${JSON.stringify({ file, name, ms: details.duration_ms })}\n`
  }
}

/** Every record the reporter wrote into `dir`, from all of its files. */
export function readTimings(dir) {
  const records = []
  for (const entry of readdirSync(dir)) {
    if (!entry.endsWith('.jsonl')) continue
    for (const line of readFileSync(join(dir, entry), 'utf8').split('\n')) {
      if (line) records.push(JSON.parse(line))
    }
  }
  return records
}

/** The `count` slowest records, slowest first; ties in file and name order. */
export function slowestTests(records, count) {
  return [...records].sort((a, b) => b.ms - a.ms || compare(a.file, b.file) || compare(a.name, b.name)).slice(0, count)
}

/** The list a root run ends with, file paths relative to `root`. */
export function formatSlowest(records, root) {
  if (records.length === 0) {
    return 'Slowest tests: none were timed.\n'
  }
  const lines = records.map(({ file, name, ms }) => {
    const seconds = `${(ms / 1000).toFixed(1)} s`.padStart(8)
    return `${seconds}  ${file ? relative(root, file) : '(no file)'} > ${name}`
  })
  return `Slowest ${records.length} tests:\n${lines.join('\n')}\n`
}

function compare(a = '', b = '') {
  return a < b ? -1 : a > b ? 1 : 0
}

// The output cap truncates rather than erroring, so the only way a caller learns its output is
// incomplete is the flag the backend sets. These run real commands through the real local
// backend with a small `maxOutputBytes`, so what is asserted is what a spawned process actually
// produces -- reading the collector's source would not prove the result carries the flag.
import assert from 'node:assert/strict'
import test from 'node:test'

import type { TerminalContext } from '../types'
import { getBackend } from './backend'

const LOCAL: TerminalContext = { type: 'local' } as TerminalContext

function exec(command: string, maxOutputBytes: number) {
  return getBackend(LOCAL).exec(LOCAL, command, { maxOutputBytes })
}

test('output within the cap is not flagged', async () => {
  const result = await exec('echo hello', 1000)
  assert.equal(result.stdout, 'hello\n')
  assert.equal(result.truncated, undefined)
  assert.equal(result.stdoutTruncated, undefined)
})

test('stdout past the cap is cut and flagged', async () => {
  const result = await exec("head -c 5000 /dev/zero | tr '\\0' x", 1000)
  assert.equal(result.stdout.length, 1000, 'the collector stops at the cap')
  assert.equal(result.stdoutTruncated, true)
  assert.equal(result.truncated, true)
})

test('stderr past the cap does not claim stdout was cut', async () => {
  // The distinction stdoutTruncated exists for: callers keep only stdout, so flagging their
  // output as incomplete because stderr overflowed is a false alarm about the part they see.
  const result = await exec("head -c 5000 /dev/zero | tr '\\0' x >&2; echo small", 1000)
  assert.equal(result.stdout, 'small\n', 'stdout arrived whole')
  assert.equal(result.stdoutTruncated, undefined, 'stdout was not cut, so it must not be flagged')
  assert.equal(result.truncated, true, 'something was still lost, and the broad flag says so')
})

test('a non-zero exit is a result, not a rejection, and still reports truncation', async () => {
  const result = await exec("head -c 5000 /dev/zero | tr '\\0' x; exit 3", 1000)
  assert.equal(result.exitCode, 3)
  assert.equal(result.stdoutTruncated, true)
})

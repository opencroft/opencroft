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

// ── stream: the third method, and the contexts that refuse it ──
//
// These run the real local backend rather than a double. What is being asserted is that output
// arrives while the command runs and that nothing written to the session comes back out -- both
// properties of the actual transport, which a double would simply be asserting about itself.

function collect(handle: { onData(fn: (d: string) => void): void; onExit(fn: () => void): void }) {
  let text = ''
  handle.onData((chunk) => {
    text += chunk
  })
  return { text: () => text, done: new Promise<void>((resolve) => handle.onExit(() => resolve())) }
}

test('a streamed local command delivers its output and then ends', async () => {
  const handle = await getBackend(LOCAL).stream(LOCAL, ['sh', '-c', 'echo first; echo second'])
  const watched = collect(handle)
  await watched.done

  // \r\n, not \n: a pipe emits bare newlines and a terminal needs both characters, or every line
  // starts where the last one ended.
  assert.equal(watched.text(), 'first\r\nsecond\r\n')
  assert.equal(handle.isAlive(), false, 'the handle reports the command as finished')
})

test('a streamed command reads its stdin, and no watcher ever sees it', async () => {
  // The reason every transport here is non-pty. A pty echoes its own stdin back to the reader, so
  // a job whose input is a compose document -- which is where resolved secret values live -- would
  // print that document to everyone watching. `wc -c` is chosen because it proves the input
  // actually ARRIVED without reprinting it: the byte count is a positive control that a command
  // which never received the input could not produce, and "the watcher did not see the secret"
  // would otherwise also be true of a command that was handed nothing.
  const handle = await getBackend(LOCAL).stream(LOCAL, ['sh', '-c', 'wc -c'], {
    stdin: 'S3CRET-VALUE-ON-STDIN',
  })
  const watched = collect(handle)
  await watched.done

  assert.ok(!watched.text().includes('S3CRET-VALUE-ON-STDIN'), 'the input is never echoed to a watcher')
  assert.equal(watched.text().trim(), '21', 'and it did reach the command, all 21 bytes of it')
})

test('a streamed command that cannot start ends like one that finished, and says why', async () => {
  const handle = await getBackend(LOCAL).stream(LOCAL, ['definitely-not-a-real-command-for-this-test'])
  const watched = collect(handle)
  await watched.done

  assert.match(watched.text(), /ENOENT|not found/i, 'the reason reaches the watcher rather than nowhere')
})

test('a context with no streaming channel refuses, and names itself', async () => {
  // Not a fallback to local: a wsl or docker-exec context names a machine that is not this one, so
  // running the command here instead would be the exact silent-wrong-host failure the dispatch
  // exists to prevent.
  for (const type of ['wsl', 'docker-exec']) {
    const ctx = { type } as TerminalContext
    await assert.rejects(
      () => getBackend(ctx).stream(ctx, ['echo', 'hi']),
      (err: Error) => {
        assert.match(err.message, /not implemented for this context/i)
        assert.ok(
          err.message.includes(type),
          `the refusal names ${type}, so the caller knows which of theirs cannot do this`,
        )
        return true
      },
    )
  }
})

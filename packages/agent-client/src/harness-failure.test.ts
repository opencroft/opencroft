import assert from 'node:assert/strict'
import test from 'node:test'

import { harnessStartError } from './harness-failure'

test('a process that exited substitutes its stderr into the message', () => {
  const error = harnessStartError(
    { stderr: ['Error response from daemon: container is not running\n'], exit: { code: 1, signal: null } },
    new Error('ACP connection closed'),
  )
  assert.match(error.message, /container is not running/)
  assert.match(error.message, /exit code 1/)
  assert.equal(error.cause instanceof Error && error.cause.message, 'ACP connection closed')
})

test('a spawn-level failure with no stderr falls back to the spawn error', () => {
  const error = harnessStartError(
    { stderr: [], spawnError: new Error('spawn node ENOENT') },
    new Error('ACP connection closed'),
  )
  assert.match(error.message, /spawn node ENOENT/)
})

test('a live process (no exit, no spawn error) is not blamed for its own stderr chatter', () => {
  const cause = new Error('ACP connection closed')
  const error = harnessStartError({ stderr: ['[info] warming up cache...\n'] }, cause)
  // Not substituted: the process never died, so this stderr is routine
  // chatter, not a diagnosis — the original protocol error stands.
  assert.equal(error, cause)
})

test('no evidence at all returns the original cause untouched', () => {
  const cause = new Error('ACP connection closed')
  assert.equal(harnessStartError({ stderr: [] }, cause), cause)
})

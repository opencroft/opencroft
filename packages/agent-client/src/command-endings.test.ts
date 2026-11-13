import assert from 'node:assert/strict'
import test from 'node:test'

import { copilotCompletedCall, opencodeCompletedCall } from './command-endings'

// The outputs below are the ones the harnesses sent over ACP (measured
// 2026-10-14), for `exit 3`, a clean run and a stopped `sleep`.

test('a Copilot shell call that exited non-zero reads as failed, a zero exit as completed', () => {
  assert.equal(
    copilotCompletedCall(
      "ls: cannot access '/definitely-not-here': No such file or directory\n<shellId: 1 completed with exit code 3>",
    ),
    'failed',
  )
  assert.equal(copilotCompletedCall('line 1\nline 2\n<shellId: 0 completed with exit code 0>'), undefined)
})

test('Copilot output without the exit line, or with it mid-output, says nothing', () => {
  assert.equal(copilotCompletedCall('<command with id: 2 stopped>'), undefined)
  assert.equal(copilotCompletedCall('<shellId: 1 completed with exit code 3>\nmore output'), undefined)
})

test('an OpenCode bash call the reader stopped reads as cancelled, anything else as completed', () => {
  assert.equal(
    opencodeCompletedCall('(no output)\n\n<shell_metadata>\nUser aborted the command\n</shell_metadata>'),
    'cancelled',
  )
  assert.equal(opencodeCompletedCall("ls: cannot access '/definitely-not-here': No such file or directory\n"), undefined)
})

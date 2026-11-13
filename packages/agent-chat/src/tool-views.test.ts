// Pins what a registered tool view is handed from a folded tool message: the
// diffs the call reported travel beside its arguments, because a harness may
// report a file change there and nowhere else.
import assert from 'node:assert/strict'
import test from 'node:test'

import { type ToolMessage, toolViewProps, toolViewState } from './tool-views'

const message = (extra: Partial<ToolMessage> = {}): ToolMessage => ({
  id: 'm1',
  kind: 'tool',
  toolCallId: 'call-1',
  title: 'Edit',
  status: 'completed',
  input: { file_path: '/tmp/a.txt', replace_all: false },
  ...extra,
})

test('toolViewProps hands a view the diffs the call reported, beside its arguments', () => {
  const diffs = [{ path: '/tmp/a.txt', oldText: 'one', newText: 'two' }]
  const props = toolViewProps(message({ diffs }), 'history')
  assert.deepEqual(props.diffs, diffs)
  assert.deepEqual(props.args, { file_path: '/tmp/a.txt', replace_all: false })
})

test('toolViewProps leaves diffs out for a call that reported none', () => {
  assert.ok(!('diffs' in toolViewProps(message(), 'history')))
})

test('a running call with output so far is still running; a settled one says how it ended', () => {
  const running = toolViewProps(message({ status: 'in_progress', output: 'line 1\n' }), 'history')
  assert.equal(running.state, 'running')
  assert.equal(running.result?.text, 'line 1\n')
  assert.equal(toolViewProps(message({ status: 'pending' }), 'history').state, 'running')
  assert.equal(toolViewProps(message({ status: 'failed' }), 'history').state, 'failed')
  assert.equal(toolViewProps(message({ status: 'cancelled' }), 'history').state, 'cancelled')
})

test('a host that gives no state has it read from the result', () => {
  assert.equal(toolViewState({}), 'running')
  assert.equal(toolViewState({ result: { text: 'ok' } }), 'completed')
  assert.equal(toolViewState({ result: { text: 'no', isError: true } }), 'failed')
  assert.equal(toolViewState({ state: 'running', result: { text: 'so far' } }), 'running')
})

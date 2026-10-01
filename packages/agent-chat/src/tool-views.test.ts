// Pins what a registered tool view is handed from a folded tool message: the
// diffs the call reported travel beside its arguments, because a harness may
// report a file change there and nowhere else.
import assert from 'node:assert/strict'
import test from 'node:test'

import { type ToolMessage, toolViewProps } from './tool-views'

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

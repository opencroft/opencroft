import assert from 'node:assert/strict'
import test from 'node:test'

import { nodeName } from './node-name'

test("a frame is named by its Label, not its type's name", () => {
  assert.equal(nodeName({ label: 'Backend', color: 'blue' }, 'Section', 'f1'), 'Backend')
})

test('a node with a name or a title is named by it', () => {
  assert.equal(nodeName({ name: 'db' }, 'Application', 'n1'), 'db')
  assert.equal(nodeName({ title: 'Notes' }, 'Markdown', 'n2'), 'Notes')
})

test("a node with no name of its own is named by its type, else its id; blank names don't count", () => {
  assert.equal(nodeName({ label: '  ' }, 'Section', 'f2'), 'Section')
  assert.equal(nodeName(undefined, undefined, 'n3'), 'n3')
})

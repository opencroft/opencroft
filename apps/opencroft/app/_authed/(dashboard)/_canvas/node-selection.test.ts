// What a selected node discloses. The first test is the one that matters: the
// content is attached to a message an agent receives, and a node's `data` is
// whatever its extension chose to keep there.

import assert from 'node:assert/strict'
import test from 'node:test'

import { nodeSelection } from './node-selection'

test('a node discloses its id, name and type -- and nothing else from its data', () => {
  const selection = nodeSelection({
    id: 'node_abc',
    type: 'postgres-database',
    data: {
      name: 'Orders DB',
      password: 'hunter2',
      connectionString: 'postgres://user:secret@host/db',
      prompt: 'a long private instruction',
    },
  })

  assert.match(selection.content, /Orders DB/)
  assert.match(selection.content, /postgres-database/)
  assert.match(selection.content, /node_abc/)

  // Named individually rather than by a "no other keys" check, so that adding a
  // field to a node's data cannot quietly satisfy this test.
  assert.doesNotMatch(selection.content, /hunter2/)
  assert.doesNotMatch(selection.content, /connectionString|postgres:\/\//)
  assert.doesNotMatch(selection.content, /a long private instruction/)
})

test('the badge shows the name, and the id stands in when there is none', () => {
  assert.equal(nodeSelection({ id: 'node_1', data: { name: 'Named' } }).label, 'Named')
  assert.equal(nodeSelection({ id: 'node_2', data: { title: 'Titled' } }).label, 'Titled')
  assert.equal(nodeSelection({ id: 'node_3' }).label, 'node_3')
  assert.equal(nodeSelection({ id: 'node_4', data: {} }).label, 'node_4')
})

test('a non-string name is not trusted to be one', () => {
  // Node data is untyped and comes from an extension, so a name that is not a
  // string is reachable. Interpolating it would put "[object Object]" in front
  // of a person; falling back to the id is at least addressable.
  assert.equal(nodeSelection({ id: 'node_5', data: { name: { first: 'not a string' } } }).label, 'node_5')
})

test('a node with no type says so rather than omitting the line', () => {
  const selection = nodeSelection({ id: 'node_6' })
  assert.match(selection.content, /Type: unknown/, 'a missing line reads as a different shape of message')
})

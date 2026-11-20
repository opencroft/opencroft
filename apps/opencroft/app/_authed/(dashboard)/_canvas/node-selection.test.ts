// What the selected canvas nodes disclose. The first test is the one that
// matters: the items travel with a message an agent receives, and a node's
// `data` is whatever its extension chose to keep there.

import assert from 'node:assert/strict'
import test from 'node:test'

import { describeSelection } from '@/app/_authed/(agent)/_shared/selection-envelope'
import { nodeSelection } from './node-selection'

const GRAPH = 'acme.default'

test('a node discloses its id, name and type -- and nothing else from its data', () => {
  const selection = nodeSelection(
    [
      {
        id: 'node_abc',
        type: 'postgres-database',
        selected: true,
        data: {
          name: 'Orders DB',
          password: 'hunter2',
          connectionString: 'postgres://user:secret@host/db',
          prompt: 'a long private instruction',
        },
      },
    ],
    GRAPH,
  )
  assert.deepEqual(selection, {
    items: [{ kind: 'node', graph: GRAPH, id: 'node_abc', name: 'Orders DB', type: 'postgres-database' }],
  })

  // And the block built from it. Named individually rather than by a "no other
  // keys" check, so that adding a field to a node's data cannot quietly satisfy
  // this test.
  const content = selection ? (describeSelection(selection, { space: 'Acme' })?.content ?? '') : ''
  assert.match(content, /Orders DB/)
  assert.doesNotMatch(content, /hunter2/)
  assert.doesNotMatch(content, /connectionString|postgres:\/\//)
  assert.doesNotMatch(content, /a long private instruction/)
})

test('every selected node is an item, and unselected ones are not', () => {
  const selection = nodeSelection(
    [
      { id: 'a', type: 'script-node', selected: true, data: { name: 'Build' } },
      { id: 'b', type: 'script-node', selected: false, data: { name: 'Idle' } },
      { id: 'c', type: 'docker', selected: true, data: { name: 'Box' } },
    ],
    GRAPH,
    'Default',
  )
  assert.deepEqual(
    selection?.items.map((item) => (item.kind === 'node' ? item.id : null)),
    ['a', 'c'],
  )
  assert.equal(selection?.place, 'Default')
})

test('nodes the graph never stores are left out: comment bubbles and subgraph boundaries', () => {
  const selection = nodeSelection(
    [
      { id: 'kept', type: 'script-node', selected: true },
      { id: 'bubble', type: 'comment', selected: true },
      { id: 'sub::inputs', type: 'subgraph-inputs', selected: true },
      { id: 'sub::outputs', type: 'subgraph-outputs', selected: true },
    ],
    GRAPH,
  )
  assert.deepEqual(
    selection?.items.map((item) => (item.kind === 'node' ? item.id : null)),
    ['kept'],
  )
})

test('nothing selected, or only browser-only nodes, is no selection at all', () => {
  assert.equal(nodeSelection([{ id: 'a', type: 'x', selected: false }], GRAPH), null)
  assert.equal(nodeSelection([{ id: 'bubble', type: 'comment', selected: true }], GRAPH), null)
})

test("the name is the one the canvas shows: label, name or title, else the type's name, else the id", () => {
  const typeNames: Record<string, string> = { 'opencroft.docker.docker': 'Docker' }
  const names = nodeSelection(
    [
      { id: 'node_1', selected: true, data: { name: 'Named' } },
      { id: 'node_2', selected: true, data: { title: 'Titled' } },
      { id: 'node_3', selected: true, type: 'section', data: { label: 'Labelled', name: 'ignored' } },
      // No name of its own: the canvas titles it by its type, and so does the quote.
      { id: 'node_4', selected: true, type: 'opencroft.docker.docker' },
      // A type the registry does not know (yet), and no type at all.
      { id: 'node_5', selected: true, type: 'not.loaded' },
      { id: 'node_6', selected: true },
      // Node data is untyped and comes from an extension, so a name that is not
      // a string is reachable; it is skipped like a missing one.
      { id: 'node_7', selected: true, type: 'opencroft.docker.docker', data: { name: { first: 'not a string' } } },
    ],
    GRAPH,
    undefined,
    (type) => typeNames[type],
  )?.items.map((item) => (item.kind === 'node' ? item.name : null))
  assert.deepEqual(names, ['Named', 'Titled', 'Labelled', 'Docker', 'node_5', 'node_6', 'Docker'])
})

test('a node with no type says so rather than leaving the field empty', () => {
  const [item] = nodeSelection([{ id: 'node_6', selected: true }], GRAPH)?.items ?? []
  assert.equal(item?.kind === 'node' ? item.type : null, 'unknown')
})

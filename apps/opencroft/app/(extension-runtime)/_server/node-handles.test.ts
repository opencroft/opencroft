import assert from 'node:assert/strict'
import test from 'node:test'

import { buildNodeTypeHandles } from './node-handles'

const handle = (id: string, role: 'source' | 'target', extras: Record<string, unknown> = {}) =>
  ({ id, role, contextType: 'terminal-context', ...extras }) as never

test('maps every node type to its owning extension and declared handles', () => {
  const map = buildNodeTypeHandles([
    { id: 'local/docker', nodes: [{ typeId: 'docker', handles: [handle('docker-out', 'source')] }] },
    { id: 'local/git', nodes: [{ typeId: 'git-workspace', handles: [handle('ws-out', 'source')] }] },
  ])
  assert.equal(map.get('docker')?.extensionId, 'local/docker')
  assert.equal(map.get('git-workspace')?.extensionId, 'local/git')
  assert.deepEqual(
    map.get('docker')?.handles.map((h) => h.id),
    ['docker-out'],
  )
})

test('a node type declaring no handles maps to an empty list, not undefined', () => {
  // Callers index straight into `.handles`; a missing array would throw rather
  // than yield "this type has no handles".
  const map = buildNodeTypeHandles([{ id: 'local/thing', nodes: [{ typeId: 'thing' }] }])
  assert.deepEqual(map.get('thing')?.handles, [])
})

test('a manifest contributing no nodes contributes no entries', () => {
  const map = buildNodeTypeHandles([{ id: 'local/nodeless' }, { id: 'local/empty', nodes: [] }])
  assert.equal(map.size, 0)
})

test('a later manifest wins a type-id collision', () => {
  // Documents current behaviour rather than endorsing it: two extensions
  // claiming one type id is a conflict, and last-write-wins is what both
  // former copies of this loop did.
  const map = buildNodeTypeHandles([
    { id: 'local/first', nodes: [{ typeId: 'shared', handles: [handle('a', 'source')] }] },
    { id: 'local/second', nodes: [{ typeId: 'shared', handles: [handle('b', 'source')] }] },
  ])
  assert.equal(map.get('shared')?.extensionId, 'local/second')
})

test('an empty manifest list yields an empty map', () => {
  assert.equal(buildNodeTypeHandles([]).size, 0)
})

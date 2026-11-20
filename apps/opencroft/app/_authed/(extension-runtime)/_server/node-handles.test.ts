import assert from 'node:assert/strict'
import test from 'node:test'

import { buildNodeTypeHandles, dynamicSourcePrefixes, expandDynamicHandles } from './node-handles'

const handle = (id: string, role: 'source' | 'target', extras: Record<string, unknown> = {}) =>
  ({ id, role, handleType: 'builtin.core.terminal-context', ...extras }) as never

test('maps every node type to its owning extension and declared handles', () => {
  const map = buildNodeTypeHandles([
    { id: 'acme.docker', nodes: [{ type: 'acme.docker.docker', handles: [handle('docker-out', 'source')] }] },
    { id: 'acme.git', nodes: [{ type: 'acme.git.git-workspace', handles: [handle('ws-out', 'source')] }] },
  ])
  assert.equal(map.get('acme.docker.docker')?.extensionId, 'acme.docker')
  assert.equal(map.get('acme.git.git-workspace')?.extensionId, 'acme.git')
  assert.deepEqual(
    map.get('acme.docker.docker')?.handles.map((h) => h.id),
    ['docker-out'],
  )
})

test('a node type declaring no handles maps to an empty list, not undefined', () => {
  // Callers index straight into `.handles`; a missing array would throw rather
  // than yield "this type has no handles".
  const map = buildNodeTypeHandles([{ id: 'acme.thing', nodes: [{ type: 'acme.thing.thing' }] }])
  assert.deepEqual(map.get('acme.thing.thing')?.handles, [])
})

test('a manifest contributing no nodes contributes no entries', () => {
  const map = buildNodeTypeHandles([{ id: 'acme.nodeless' }, { id: 'acme.empty', nodes: [] }])
  assert.equal(map.size, 0)
})

test('two extensions declaring one bare name own two different types', () => {
  const map = buildNodeTypeHandles([
    { id: 'acme.first', nodes: [{ type: 'acme.first.shared', handles: [handle('a', 'source')] }] },
    { id: 'acme.second', nodes: [{ type: 'acme.second.shared', handles: [handle('b', 'source')] }] },
  ])
  assert.equal(map.get('acme.first.shared')?.extensionId, 'acme.first')
  assert.equal(map.get('acme.second.shared')?.extensionId, 'acme.second')
})

test('an empty manifest list yields an empty map', () => {
  assert.equal(buildNodeTypeHandles([]).size, 0)
})

test('the prefixes expanded are those of the dynamic source handles only', () => {
  const declared = [
    handle('terminal', 'source'),
    handle('shell-', 'source', { dynamic: true }),
    handle('in-', 'target', { dynamic: true }),
    handle('log-', 'source', { dynamic: true }),
  ]
  assert.deepEqual(dynamicSourcePrefixes(declared), ['shell-', 'log-'])
})

test('the lister is asked once per prefix with the node, and only ids under the prefix asked are kept', async () => {
  const asked: Array<[string, Record<string, unknown>, string]> = []
  const lister = {
    list: (node: { id: string; data: Record<string, unknown> }, prefix: string) => {
      asked.push([node.id, node.data, prefix])
      return prefix === 'shell-' ? ['shell-a', 'log-stray', 'shell-b', 'shell-a'] : ['log-1']
    },
  }
  const data = { __resolvedContexts: { 'host-in': { sourceNodeId: 'host-1' } } }

  const ids = await expandDynamicHandles({ id: 'n-1', data }, ['shell-', 'log-'], lister)

  assert.deepEqual(ids, ['shell-a', 'shell-b', 'log-1'])
  assert.deepEqual(asked, [
    ['n-1', data, 'shell-'],
    ['n-1', data, 'log-'],
  ])
})

test('an async lister is awaited, and a non-string id is dropped', async () => {
  const lister = { list: async () => ['shell-a', 7, null, 'shell-b'] as unknown as string[] }
  assert.deepEqual(await expandDynamicHandles({ id: 'n-1' }, ['shell-'], lister), ['shell-a', 'shell-b'])
})

test('no lister, or no prefix, lists nothing and asks nothing', async () => {
  let calls = 0
  const lister = {
    list: () => {
      calls++
      return ['shell-a']
    },
  }
  assert.deepEqual(await expandDynamicHandles({ id: 'n-1' }, ['shell-'], undefined), [])
  assert.deepEqual(await expandDynamicHandles({ id: 'n-1' }, [], lister), [])
  assert.equal(calls, 0)
})

test('a lister that throws, rejects or answers no array lists nothing', async (t) => {
  t.mock.method(console, 'error', () => {})
  const throwing = {
    list: () => {
      throw new Error('lister bug')
    },
  }
  const rejecting = { list: () => Promise.reject(new Error('host unreachable')) }
  const notAList = { list: () => 'shell-a' as unknown as string[] }
  for (const lister of [throwing, rejecting, notAList]) {
    assert.deepEqual(await expandDynamicHandles({ id: 'n-1' }, ['shell-'], lister), [])
  }
})

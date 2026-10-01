import assert from 'node:assert/strict'
import test from 'node:test'

import { buildNodeTypeHandles, dockerApplicationType, findDockerExtensionId } from './node-handles'

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

test('the docker extension is whichever declares the bare type docker, under any owner', () => {
  const manifests = [
    { id: 'acme.widgets', nodes: [{ type: 'acme.widgets.gauge' }] },
    { id: 'some-owner.containers', nodes: [{ type: 'some-owner.containers.docker' }] },
  ]
  assert.equal(findDockerExtensionId(manifests), 'some-owner.containers')
  assert.equal(dockerApplicationType(findDockerExtensionId(manifests)), 'some-owner.containers.application')
})

test('without a docker extension there is no docker application type', () => {
  const manifests = [{ id: 'acme.widgets', nodes: [{ type: 'acme.widgets.application' }] }]
  assert.equal(findDockerExtensionId(manifests), null)
  assert.equal(dockerApplicationType(null), null)
})

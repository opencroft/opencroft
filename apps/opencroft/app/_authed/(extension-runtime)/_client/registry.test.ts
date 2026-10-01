// The client registry files a loaded declaration under qualified types: what
// the canvas resolves a stored node by, and what it creates new nodes with.
import assert from 'node:assert/strict'
import test, { afterEach } from 'node:test'

import type { ExtensionDeclaration } from './host'
import { loadedDeclaration } from './loaded-declaration'
import { extensionRegistry } from './registry'

afterEach(() => {
  extensionRegistry.clear()
})

const component = () => null

// Two extensions declaring the same bare node and handle type names.
function declaring(told: string[]): ExtensionDeclaration {
  return {
    manifest: {},
    handleTypes: [{ id: 'signal', label: 'Signal', color: 'red' }],
    nodes: [
      {
        type: 'gauge',
        name: 'Gauge',
        component,
        handles: [{ id: 'out', role: 'source', handleType: 'signal' }],
        exposeOutput: (_handleId, _data, type, _nodeId, contexts) => {
          told.push(type)
          return contexts.feed?.value ?? 'value'
        },
      },
    ],
  }
}

test('a node resolves under its qualified type, and two extensions sharing a bare name keep two types', () => {
  const told: string[] = []
  extensionRegistry.register(loadedDeclaration(declaring(told), { id: 'acme.widgets', folder: 'acme.widgets' }))
  extensionRegistry.register(loadedDeclaration(declaring(told), { id: 'other.widgets', folder: 'other.widgets' }))

  assert.equal(extensionRegistry.resolveNode('acme.widgets.gauge')?.extension.manifest.id, 'acme.widgets')
  assert.equal(extensionRegistry.resolveNode('other.widgets.gauge')?.extension.manifest.id, 'other.widgets')
  assert.equal(extensionRegistry.resolveNode('gauge'), undefined, 'a bare name resolves to nothing')
  assert.deepEqual(
    extensionRegistry
      .allNodes()
      .map((node) => node.type)
      .sort(),
    ['acme.widgets.gauge', 'other.widgets.gauge'],
    'what the palette creates nodes with',
  )
})

test("a node's handles and the handle types carry the qualified handle type", () => {
  extensionRegistry.register(loadedDeclaration(declaring([]), { id: 'acme.widgets', folder: 'acme.widgets' }))

  assert.deepEqual(extensionRegistry.resolveNode('acme.widgets.gauge')?.handles, [
    { id: 'out', role: 'source', handleType: 'acme.widgets.signal' },
  ])
  assert.equal(extensionRegistry.getHandleType('acme.widgets.signal')?.label, 'Signal')
  assert.equal(extensionRegistry.getHandleType('signal'), undefined)
})

test("the declaring extension's exposeOutput is told the node's bare type and handed its inputs", () => {
  const told: string[] = []
  extensionRegistry.register(loadedDeclaration(declaring(told), { id: 'acme.widgets', folder: 'acme.widgets' }))

  const resolved = extensionRegistry.resolveNode('acme.widgets.gauge')
  const feed = { sourceNodeId: 'node-0', sourceHandleId: 'out', type: 'acme.widgets.signal', value: 'fed' }
  assert.equal(resolved?.exposeOutput?.('out', {}, 'node-1', {}), 'value')
  assert.equal(resolved?.exposeOutput?.('out', {}, 'node-1', { feed }), 'fed')
  assert.deepEqual(told, ['gauge', 'gauge'])
})

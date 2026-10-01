import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import path from 'node:path'
import test from 'node:test'

// The server knows an extension's node and handle types only from its
// extension.json: the type → extension map, context resolution and the
// unknown-types scan all read the manifest, never the client bundle. Core's
// client declaration registers the same types a second time, so every type it
// registers must also be in the manifest, or the server treats a working node
// as belonging to no extension.
//
// Read as source text: the client module resolves `@opencroft/client` through
// the host's runtime shim and cannot be imported under the test runner.

const here = import.meta.dirname
const manifest = JSON.parse(readFileSync(path.join(here, 'extension.json'), 'utf-8')) as {
  nodes: Array<{ type: string }>
  handleTypes: Array<{ id: string }>
}
const clientSource = readFileSync(path.join(here, 'src', 'client.tsx'), 'utf-8')

// A node entry of `defineExtension({ nodes: [...] })` opens with its type at
// the entry's own indentation; a `type` nested deeper (inside a node's own
// data) is not a node declaration.
function clientNodeTypes(): string[] {
  return [...clientSource.matchAll(/^ {6}type: '([a-z0-9-]+)',$/gm)].map((match) => match[1]).sort()
}

function clientHandleTypes(): string[] {
  const block = clientSource.match(/^ {2}handleTypes: \[\n([\s\S]*?)^ {2}\],$/m)?.[1] ?? ''
  return [...block.matchAll(/\{ id: '([a-z0-9-]+)'/g)].map((match) => match[1]).sort()
}

test('the source extraction sees the whole client declaration', () => {
  // The first and last node entries, and a handle type from each end of the
  // list: an extractor that stopped early or started late would miss one.
  const nodes = clientNodeTypes()
  assert.ok(nodes.includes('localhost') && nodes.includes('section'), `node types read: ${nodes.join(', ')}`)
  const handles = clientHandleTypes()
  assert.ok(
    handles.includes('terminal-context') && handles.includes('agent-instruction'),
    `handle types read: ${handles.join(', ')}`,
  )
})

test('core manifest declares every node type the core client registers', () => {
  assert.deepEqual(manifest.nodes.map((node) => node.type).sort(), clientNodeTypes())
})

test('core manifest declares every handle type the core client registers', () => {
  assert.deepEqual(manifest.handleTypes.map((handleType) => handleType.id).sort(), clientHandleTypes())
})

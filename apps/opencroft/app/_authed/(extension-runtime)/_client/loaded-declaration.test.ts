import assert from 'node:assert/strict'
import test from 'node:test'

import type { ExtensionDeclaration } from '@/app/_authed/(extension-runtime)/_client/host'
import { loadedDeclaration } from './loaded-declaration'

/** Runs `run` with console.warn collected, and puts the real one back. */
function collectingWarnings(run: () => void): string[] {
  const warnings: string[] = []
  const original = console.warn
  console.warn = (...args: unknown[]) => {
    warnings.push(args.join(' '))
  }
  try {
    run()
  } finally {
    console.warn = original
  }
  return warnings
}

const served = { id: 'acme.widgets', folder: 'local.widgets-dev' }

function declaration(manifest: ExtensionDeclaration['manifest']): ExtensionDeclaration {
  return { manifest, nodes: [] }
}

test('a bundle that declares no id is filed under the served id and folder', () => {
  let loaded: ReturnType<typeof loadedDeclaration> | undefined
  const warnings = collectingWarnings(() => {
    loaded = loadedDeclaration(declaration({ name: 'Widgets' }), served)
  })

  assert.deepEqual(loaded?.manifest, { name: 'Widgets', id: 'acme.widgets', folder: 'local.widgets-dev' })
  assert.deepEqual(warnings, [])
})

test('a bundle that declares the served id is not warned about', () => {
  const warnings = collectingWarnings(() => {
    loadedDeclaration(declaration({ id: 'acme.widgets' }), served)
  })

  assert.deepEqual(warnings, [])
})

test('a bundle that declares another id is filed under the served one, and the warning names the extension', () => {
  let loaded: ReturnType<typeof loadedDeclaration> | undefined
  const warnings = collectingWarnings(() => {
    loaded = loadedDeclaration(declaration({ id: 'local/widgets' }), served)
  })

  assert.equal(loaded?.manifest.id, 'acme.widgets')
  assert.equal(warnings.length, 1)
  assert.match(warnings[0], /acme\.widgets/)
  assert.match(warnings[0], /local\/widgets/)
})

const component = () => null

test("the bundle's node, App and handle types are qualified with the served id, under their current keys", () => {
  const loaded = loadedDeclaration(
    {
      manifest: {},
      handleTypes: [{ id: 'signal', label: 'Signal', color: 'red' }],
      nodes: [
        {
          type: 'gauge',
          name: 'Gauge',
          component,
          handles: [
            { id: 'in', role: 'target', handleType: 'signal' },
            { id: 'term', role: 'target', handleType: 'builtin.core.terminal-context' },
          ],
        },
      ],
      provides: { apps: [{ type: 'board', title: 'Board' }], panels: [{ id: 'side' }] },
    },
    served,
  )

  assert.deepEqual(loaded.handleTypes, [{ id: 'acme.widgets.signal', label: 'Signal', color: 'red' }])
  assert.equal(loaded.nodes?.[0].type, 'acme.widgets.gauge')
  assert.equal(loaded.nodes?.[0].component, component, 'the rest of a node is kept')
  assert.deepEqual(loaded.nodes?.[0].handles, [
    { id: 'in', role: 'target', handleType: 'acme.widgets.signal' },
    { id: 'term', role: 'target', handleType: 'builtin.core.terminal-context' },
  ])
  assert.deepEqual(loaded.provides, {
    apps: [{ type: 'acme.widgets.board', title: 'Board' }],
    panels: [{ id: 'side' }],
  })
})

test('the deprecated keys are read, and nothing is left under them', () => {
  const nodes = [
    { typeId: 'gauge', name: 'Gauge', component, handles: [{ id: 'in', role: 'target', contextType: 'signal' }] },
  ] as unknown as ExtensionDeclaration['nodes']
  const loaded = loadedDeclaration(
    {
      manifest: {},
      contexts: [{ id: 'signal', label: 'Signal', color: 'red' }],
      nodes,
      provides: { apps: [{ slug: 'board', title: 'Board' }] },
    },
    served,
  )

  assert.equal(loaded.nodes?.[0].type, 'acme.widgets.gauge')
  assert.equal('typeId' in (loaded.nodes?.[0] ?? {}), false)
  assert.deepEqual(loaded.nodes?.[0].handles, [{ id: 'in', role: 'target', handleType: 'acme.widgets.signal' }])
  assert.deepEqual(loaded.handleTypes?.[0].id, 'acme.widgets.signal')
  assert.equal('contexts' in loaded, false)
  assert.deepEqual(loaded.provides, { apps: [{ type: 'acme.widgets.board', title: 'Board' }] })
})

test('a bundle declaring a dotted node type is refused, naming the extension', () => {
  assert.throws(
    () => loadedDeclaration({ manifest: {}, nodes: [{ type: 'a.gauge', name: 'Gauge', component }] }, served),
    /acme\.widgets.*"a\.gauge"/,
  )
})

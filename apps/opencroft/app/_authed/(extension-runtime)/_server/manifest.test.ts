// A declared manifest as the runtime reads it: every type qualified with the id
// the extension runs under, under its current key only, and a declaration that
// cannot be qualified refused by name.
import assert from 'node:assert/strict'
import test from 'node:test'

import { type DeclaredManifest, manifestForDisplay, normalizeManifest } from './manifest'

const ID = 'acme.widgets'

/** Runs `run` with console.warn collected, and puts the real one back. */
function collectingWarnings<T>(run: () => T): { result: T; warnings: string[] } {
  const warnings: string[] = []
  const original = console.warn
  console.warn = (...args: unknown[]) => {
    warnings.push(args.join(' '))
  }
  try {
    return { result: run(), warnings }
  } finally {
    console.warn = original
  }
}

function manifest(fields: Partial<DeclaredManifest>): DeclaredManifest {
  return { id: 'ignored', name: 'Widgets', version: '1.0.0', ...fields } as DeclaredManifest
}

test('node, App and handle types come back qualified with the id the extension runs under', () => {
  const normalized = normalizeManifest(
    manifest({
      handleTypes: [{ id: 'signal', label: 'Signal', color: 'red' }],
      nodes: [
        {
          type: 'gauge',
          name: 'Gauge',
          handles: [
            { id: 'in', role: 'target', handleType: 'signal' },
            { id: 'term', role: 'target', handleType: 'builtin.core.terminal-context' },
          ],
        },
      ],
      provides: {
        apps: [{ type: 'board', title: 'Board', handles: [{ id: 'out', handleType: 'signal' }] }],
        panels: [{ id: 'side' }],
      },
    }),
    ID,
  )

  assert.equal(normalized.id, ID)
  assert.deepEqual(normalized.handleTypes, [{ id: 'acme.widgets.signal', label: 'Signal', color: 'red' }])
  assert.deepEqual(normalized.nodes, [
    {
      type: 'acme.widgets.gauge',
      name: 'Gauge',
      handles: [
        { id: 'in', role: 'target', handleType: 'acme.widgets.signal' },
        { id: 'term', role: 'target', handleType: 'builtin.core.terminal-context' },
      ],
    },
  ])
  assert.deepEqual(normalized.provides, {
    apps: [{ type: 'acme.widgets.board', title: 'Board', handles: [{ id: 'out', handleType: 'acme.widgets.signal' }] }],
    panels: [{ id: 'side' }],
  })
})

test('the deprecated keys are read, and the manifest comes back without them', () => {
  const { result, warnings } = collectingWarnings(() =>
    normalizeManifest(
      manifest({
        contexts: [{ id: 'signal', label: 'Signal', color: 'red' }],
        nodes: [{ typeId: 'gauge', name: 'Gauge', handles: [{ id: 'in', role: 'target', contextType: 'signal' }] }],
        provides: { apps: [{ slug: 'board', title: 'Board' }] },
      } as unknown as Partial<DeclaredManifest>),
      ID,
    ),
  )

  assert.deepEqual(result.handleTypes, [{ id: 'acme.widgets.signal', label: 'Signal', color: 'red' }])
  assert.equal('contexts' in result, false)
  assert.deepEqual(result.nodes, [
    {
      type: 'acme.widgets.gauge',
      name: 'Gauge',
      handles: [{ id: 'in', role: 'target', handleType: 'acme.widgets.signal' }],
    },
  ])
  assert.deepEqual(result.provides, { apps: [{ type: 'acme.widgets.board', title: 'Board' }] })
  assert.deepEqual(warnings, [], 'reading a deprecated key alone is not a conflict')
})

test("a bare core handle type under the deprecated contextType is core's, and under handleType the extension's own", () => {
  const normalized = normalizeManifest(
    manifest({
      nodes: [
        {
          type: 'gauge',
          name: 'Gauge',
          handles: [
            { id: 'old', role: 'target', contextType: 'terminal-context' },
            { id: 'new', role: 'target', handleType: 'terminal-context' },
          ],
        },
      ],
    } as unknown as Partial<DeclaredManifest>),
    ID,
  )

  assert.deepEqual(normalized.nodes?.[0].handles, [
    { id: 'old', role: 'target', handleType: 'builtin.core.terminal-context' },
    { id: 'new', role: 'target', handleType: 'acme.widgets.terminal-context' },
  ])
})

test('where a current key and its deprecated one disagree, the current one wins and a warning names the extension and key', () => {
  const { result, warnings } = collectingWarnings(() =>
    normalizeManifest(
      manifest({
        nodes: [{ type: 'gauge', typeId: 'dial', name: 'Gauge' }],
        provides: { apps: [{ type: 'board', slug: 'board', title: 'Board' }] },
      }),
      ID,
    ),
  )

  assert.equal(result.nodes?.[0].type, 'acme.widgets.gauge')
  assert.equal(warnings.length, 1, 'one warning, for the one pair that disagrees')
  assert.match(warnings[0], /acme\.widgets/)
  assert.match(warnings[0], /"type".*"typeId"/)
})

test('a declared type with a dot in it is refused, naming the extension', () => {
  assert.throws(
    () => normalizeManifest(manifest({ nodes: [{ type: 'acme.gauge', name: 'Gauge' }] }), ID),
    /Extension acme\.widgets declares the node type "acme\.gauge"/,
  )
  assert.throws(
    () => normalizeManifest(manifest({ provides: { apps: [{ type: 'a.board', title: 'Board' }] } }), ID),
    /Extension acme\.widgets declares the App type "a\.board"/,
  )
  assert.throws(
    () => normalizeManifest(manifest({ handleTypes: [{ id: 'sig.nal', label: 'Signal', color: 'red' }] }), ID),
    /Extension acme\.widgets declares the handle type "sig\.nal"/,
  )
})

test('one bare type declared twice among the nodes, or among the Apps, is refused', () => {
  assert.throws(
    () =>
      normalizeManifest(
        manifest({
          nodes: [{ type: 'gauge', name: 'Gauge' }, { typeId: 'gauge', name: 'Another gauge' } as never],
        }),
        ID,
      ),
    /acme\.widgets declares the node type "gauge" twice/,
  )
  assert.throws(
    () =>
      normalizeManifest(
        manifest({
          provides: {
            apps: [
              { type: 'board', title: 'Board' },
              { type: 'board', title: 'Board again' },
            ],
          },
        }),
        ID,
      ),
    /acme\.widgets declares the App type "board" twice/,
  )
})

test('a node and an App may share a bare name: they are different kinds of type', () => {
  const normalized = normalizeManifest(
    manifest({ nodes: [{ type: 'board', name: 'Board' }], provides: { apps: [{ type: 'board', title: 'Board' }] } }),
    ID,
  )
  assert.equal(normalized.nodes?.[0].type, 'acme.widgets.board')
})

test('a handle naming a type that is neither bare nor qualified is refused', () => {
  assert.throws(
    () =>
      normalizeManifest(
        manifest({
          nodes: [{ type: 'gauge', name: 'Gauge', handles: [{ id: 'in', role: 'target', handleType: 'core.signal' }] }],
        }),
        ID,
      ),
    /Extension acme\.widgets declares a handle carrying "core\.signal"/,
  )
})

test('a manifest the runtime refuses is still shown, by its identity, without the types it declares', () => {
  const { result, warnings } = collectingWarnings(() =>
    manifestForDisplay(manifest({ description: 'Gauges', nodes: [{ type: 'a.gauge', name: 'Gauge' }] }), ID),
  )
  assert.deepEqual(result, { name: 'Widgets', version: '1.0.0', description: 'Gauges', id: ID })
  assert.equal(warnings.length, 1)
})

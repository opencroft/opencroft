import assert from 'node:assert/strict'
import test from 'node:test'

import { declaredIconNames } from './_declared-icons'

test('collects the icon of every entry, however deeply it sits', () => {
  const declaration = {
    manifest: { id: 'acme.widgets', provides: { apps: [{ slug: 'board', icon: 'LayoutGrid' }] } },
    nodes: [
      {
        type: 'gauge',
        icon: 'Gauge',
        inspectorTabs: [{ id: 'log', icon: 'ScrollText' }],
        contextMenuItems: [{ id: 'reset', icon: 'RotateCcw' }],
      },
    ],
    settings: [{ id: 'general', icon: 'Settings' }],
  }
  assert.deepEqual(declaredIconNames(declaration).sort(), [
    'Gauge',
    'LayoutGrid',
    'RotateCcw',
    'ScrollText',
    'Settings',
  ])
})

test('a name given twice is listed once, and an empty or non-string icon not at all', () => {
  assert.deepEqual(declaredIconNames([{ icon: 'Box' }, { icon: 'Box' }, { icon: '' }, { icon: 3 }]), ['Box'])
})

test('components, class instances and cycles are not walked', () => {
  const component = Object.assign(() => null, { icon: 'FromAFunction' })
  const instance = new (class {
    icon = 'FromAnInstance'
  })()
  const cyclic: Record<string, unknown> = { icon: 'Repeat' }
  cyclic.self = cyclic
  assert.deepEqual(declaredIconNames({ component, instance, cyclic }), ['Repeat'])
})

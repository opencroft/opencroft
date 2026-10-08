// Which inspector tabs stay mounted: a tab that asks to be kept stays mounted across tab switches
// on the same node, and goes when the node changes or the inspector closes.
import assert from 'node:assert/strict'
import test from 'node:test'

import { installDomEnvironment } from '@/test-support/dom-environment'

await installDomEnvironment()

// After the DOM exists, never before -- react-dom binds to the globals it finds.
const { act, createElement, useEffect } = await import('react')
const { createRoot } = await import('react-dom/client')
const { InspectorTabBody } = await import('./inspector-tab-body')

type InspectorTabEntry = import('./inspector-tab-body').InspectorTabEntry

function tracked(name: string, events: string[]) {
  return function Tracked({ nodeId }: { nodeId: string }) {
    useEffect(() => {
      events.push(`mount ${name} ${nodeId}`)
      return () => {
        events.push(`unmount ${name} ${nodeId}`)
      }
    }, [nodeId])
    return createElement('span', { 'data-tab': name }, name)
  }
}

function setup() {
  const events: string[] = []
  const tabs: InspectorTabEntry[] = [
    { id: 'details', fullHeight: true, component: tracked('details', events) },
    { id: 'terminal', fullHeight: true, keepMounted: true, component: tracked('terminal', events) },
  ]
  const container = document.createElement('div')
  document.body.append(container)
  const root = createRoot(container)
  const show = (nodeId: string, activeId: string) =>
    act(() =>
      root.render(
        createElement(InspectorTabBody, {
          nodeId,
          tabs,
          active: tabs.find((tab) => tab.id === activeId) as InspectorTabEntry,
          inspectorProps: { nodeId },
        }),
      ),
    )
  const terminalVisible = () => {
    const span = container.querySelector('[data-tab="terminal"]')
    return span ? !span.closest('.hidden') : null
  }
  const close = () => {
    act(() => root.unmount())
    container.remove()
  }
  return { events, show, terminalVisible, close }
}

test('a kept tab survives switching to another tab and back, hidden meanwhile', () => {
  const s = setup()
  try {
    s.show('node-1', 'terminal')
    s.show('node-1', 'details')
    assert.equal(s.terminalVisible(), false, 'still mounted, not shown')
    s.show('node-1', 'terminal')

    assert.equal(s.terminalVisible(), true)
    assert.deepEqual(
      s.events.filter((e) => e.includes('terminal')),
      ['mount terminal node-1'],
      'mounted once, never unmounted',
    )
  } finally {
    s.close()
  }
})

test('a tab not asking to be kept unmounts when another is picked: the control for the test above', () => {
  const s = setup()
  try {
    s.show('node-1', 'details')
    s.show('node-1', 'terminal')

    assert.deepEqual(
      s.events.filter((e) => e.includes('details')),
      ['mount details node-1', 'unmount details node-1'],
    )
  } finally {
    s.close()
  }
})

test('a kept tab unmounts when the inspector moves to another node', () => {
  const s = setup()
  try {
    s.show('node-1', 'terminal')
    s.show('node-2', 'details')

    assert.deepEqual(
      s.events.filter((e) => e.includes('terminal')),
      ['mount terminal node-1', 'unmount terminal node-1'],
    )
    assert.equal(s.terminalVisible(), null, 'nothing of it is left')
  } finally {
    s.close()
  }
})

test('a kept tab unmounts when the inspector closes', () => {
  const s = setup()
  s.show('node-1', 'terminal')
  s.show('node-1', 'details')
  s.close()

  assert.deepEqual(
    s.events.filter((e) => e.includes('terminal')),
    ['mount terminal node-1', 'unmount terminal node-1'],
  )
})

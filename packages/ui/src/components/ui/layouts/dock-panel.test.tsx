// The surface a panel is docked beside keeps its state while the panel opens,
// closes and moves between edges: a canvas there must not be torn down and
// rebuilt each time. Mounted in a DOM because what is checked is which
// elements React keeps.

import assert from 'node:assert/strict'
import { after, before, test } from 'node:test'

import { JSDOM } from 'jsdom'

import type { DockSide } from './dock-panel'

const dom = new JSDOM('<!doctype html><html><body><div id="root"></div></body></html>', {
  url: 'http://localhost/',
  pretendToBeVisual: true,
})

class FakeResizeObserver {
  observe() {}
  unobserve() {}
  disconnect() {}
}

const globals = globalThis as unknown as Record<string, unknown>
const savedGlobals = new Map<string, PropertyDescriptor | undefined>()

before(() => {
  const names = ['window', 'document', 'HTMLElement', 'Element', 'Node', 'DOMRect', 'getComputedStyle']
  for (const name of [...names, 'navigator', 'ResizeObserver', 'IS_REACT_ACT_ENVIRONMENT']) {
    savedGlobals.set(name, Object.getOwnPropertyDescriptor(globalThis, name))
  }
  for (const name of names) {
    Object.defineProperty(globalThis, name, {
      value: (dom.window as unknown as Record<string, unknown>)[name],
      configurable: true,
      writable: true,
    })
  }
  Object.defineProperty(globalThis, 'navigator', { value: dom.window.navigator, configurable: true })
  ;(dom.window as unknown as Record<string, unknown>).ResizeObserver = FakeResizeObserver
  globals.ResizeObserver = FakeResizeObserver
  globals.IS_REACT_ACT_ENVIRONMENT = true
})

after(() => {
  for (const [name, descriptor] of savedGlobals) {
    if (descriptor) {
      Object.defineProperty(globalThis, name, descriptor)
    } else {
      delete globals[name]
    }
  }
  dom.window.close()
})

type Arrangement = { open: boolean; dock: DockSide }

// Imported after the DOM exists: react-dom binds to the globals it finds when
// first loaded. Renders the panel in each arrangement in turn, with a
// remembered size, and reports for each how many times the effects of the
// surface and of the docked panel's content have run, whether each is still
// the element it was the last time it was drawn, and whether the docked panel
// is drawn.
//
// Under StrictMode, as an app runs in development: there React runs a new
// element's effects twice, and runs them again when it moves an element among
// its siblings. So 2 is one mount, and a count that grows without a mount
// means an element was moved.
async function arrange(arrangements: Arrangement[]) {
  const { StrictMode, act, createElement, useEffect, useState } = await import('react')
  const { createRoot } = await import('react-dom/client')
  const { DockPanel } = await import('./dock-panel')

  const runs = { surface: 0, panel: 0 }
  function Counted({ id }: { id: 'surface' | 'panel' }) {
    useEffect(() => {
      runs[id] += 1
    }, [id])
    return createElement('div', { id })
  }
  let apply: (next: Arrangement) => void = () => {}
  function Harness() {
    const [arrangement, setArrangement] = useState<Arrangement>(arrangements[0])
    apply = setArrangement
    return createElement(DockPanel, {
      ...arrangement,
      size: 40,
      panel: createElement(Counted, { id: 'panel' }),
      children: createElement(Counted, { id: 'surface' }),
    })
  }

  const root = createRoot(dom.window.document.getElementById('root') as HTMLElement)
  await act(async () => root.render(createElement(StrictMode, null, createElement(Harness))))
  const byId = (id: string) => dom.window.document.getElementById(id)
  const last = { surface: byId('surface'), panel: byId('panel') }
  const seen: { surface: number; panel: number; sameSurface: boolean; samePanel: boolean; docked: boolean }[] = []
  try {
    for (const arrangement of arrangements) {
      await act(async () => apply(arrangement))
      const now = { surface: byId('surface'), panel: byId('panel') }
      seen.push({
        ...runs,
        sameSurface: now.surface === last.surface,
        samePanel: now.panel === last.panel,
        docked: now.panel !== null,
      })
      if (now.panel) {
        last.panel = now.panel
      }
    }
    return seen
  } finally {
    await act(async () => root.unmount())
  }
}

test('the surface stays mounted and in place while the panel opens, moves between edges and closes', async () => {
  const arrangements: Arrangement[] = [
    { open: false, dock: 'right' },
    { open: true, dock: 'right' },
    { open: true, dock: 'left' },
    { open: true, dock: 'bottom' },
    { open: true, dock: 'left' },
    { open: true, dock: 'right' },
    { open: false, dock: 'right' },
    { open: true, dock: 'right' },
    { open: false, dock: 'right' },
    { open: true, dock: 'left' },
  ]
  const surface = { surface: 2, sameSurface: true }
  assert.deepEqual(await arrange(arrangements), [
    { ...surface, panel: 0, samePanel: true, docked: false },
    { ...surface, panel: 2, samePanel: false, docked: true },
    // The panel's content moves between the edges as it is, too.
    { ...surface, panel: 2, samePanel: true, docked: true },
    { ...surface, panel: 2, samePanel: true, docked: true },
    { ...surface, panel: 2, samePanel: true, docked: true },
    { ...surface, panel: 2, samePanel: true, docked: true },
    { ...surface, panel: 2, samePanel: false, docked: false },
    // Shown again, at the remembered size, on the edge it left and another.
    { ...surface, panel: 4, samePanel: false, docked: true },
    { ...surface, panel: 4, samePanel: false, docked: false },
    { ...surface, panel: 6, samePanel: false, docked: true },
  ])
})

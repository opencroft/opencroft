// The right sidebar is a host for panels that extensions publish. These render
// against a real DOM because what they assert — that nothing appears until
// something is published, and that the panel host joins the existing row rather
// than opening its own — is about what ends up in the tree.
import assert from 'node:assert/strict'
import test, { after, beforeEach } from 'node:test'

import { installDomEnvironment } from '@/test-support/dom-environment'

const dom = await installDomEnvironment()

// The sidebar asks whether the viewport is mobile; the harness has no media
// query implementation, so answer "desktop" for the duration.
;(globalThis.window as unknown as { matchMedia: () => unknown }).matchMedia = () => ({
  matches: false,
  addEventListener: () => {},
  removeEventListener: () => {},
})

// After the DOM exists, never before — react-dom binds to the globals it finds.
const { act, createElement } = await import('react')
const { createRoot } = await import('react-dom/client')
const { providerRegistry, useProvided } = await import('@/app/_authed/(extension-runtime)/_client/provides')
const { SidebarProvider } = await import('ui/components/ui/sidebar')
const { RIGHT_SIDEBAR_PANELS, RightSidebar } = await import('@/app/_shell/right-sidebar')

after(() => dom.cleanup())

// The one-time extension load is shared and module-level: the first consumer to
// ask decides what gets called. Arming it with a loader that does nothing means
// mounting the sidebar never reaches for real extension manifests.
async function armExtensionLoad(): Promise<void> {
  function Arm() {
    useProvided('arming-only', async () => {})
    return null
  }
  const root = createRoot(dom.container)
  await act(async () => {
    root.render(createElement(Arm, null))
  })
  await act(async () => {
    root.unmount()
  })
}

await armExtensionLoad()

const EXTENSION_ID = 'acme.panel-source'

function panel(id: string, label: string) {
  return {
    id,
    label,
    component: () => createElement('div', { 'data-testid': `body-${id}` }, `${id} body`),
  }
}

function publish(...panels: ReturnType<typeof panel>[]): void {
  providerRegistry.register(EXTENSION_ID, { [RIGHT_SIDEBAR_PANELS]: panels })
}

/** Mount the sidebar in a row, the way the application shell composes it. */
async function mountInRow(): Promise<void> {
  const root = createRoot(dom.container)
  after(() => {
    act(() => root.unmount())
  })
  await act(async () => {
    root.render(
      createElement(
        SidebarProvider,
        null,
        createElement('div', { 'data-testid': 'page-content' }),
        createElement(RightSidebar, null),
      ),
    )
  })
}

beforeEach(() => {
  providerRegistry.register(EXTENSION_ID, {})
})

test('nothing is rendered until a panel is published', async () => {
  await mountInRow()

  assert.equal(
    dom.container.querySelector('[data-testid="right-sidebar"]'),
    null,
    'a page with no contributed panels must look exactly as it did',
  )
})

test('a published panel appears, with its body shown', async () => {
  publish(panel('outline', 'Outline'))
  await mountInRow()

  assert.notEqual(dom.container.querySelector('[data-testid="right-sidebar"]'), null)
  assert.notEqual(dom.container.querySelector('[data-testid="body-outline"]'), null)
})

test('every published panel gets a tab, and the first is the one open', async () => {
  publish(panel('outline', 'Outline'), panel('palette', 'Palette'))
  await mountInRow()

  const labels = Array.from(dom.container.querySelectorAll('button')).map((b) => b.textContent)
  assert.deepEqual(labels, ['Outline', 'Palette'])
  assert.notEqual(dom.container.querySelector('[data-testid="body-outline"]'), null)
  assert.equal(dom.container.querySelector('[data-testid="body-palette"]'), null)
})

test('choosing another tab swaps which panel is shown', async () => {
  publish(panel('outline', 'Outline'), panel('palette', 'Palette'))
  await mountInRow()

  const palette = Array.from(dom.container.querySelectorAll('button')).find((b) => b.textContent === 'Palette')
  assert.ok(palette, 'the second panel has a tab to choose')

  await act(async () => {
    palette.dispatchEvent(new globalThis.window.MouseEvent('click', { bubbles: true }))
  })

  assert.notEqual(dom.container.querySelector('[data-testid="body-palette"]'), null)
  assert.equal(dom.container.querySelector('[data-testid="body-outline"]'), null)
})

test('the panel host joins the page row instead of opening one of its own', async () => {
  // The reason it takes the sidebar state without the wrapper. A second
  // full-width flex container nested in the row would change that layout
  // rather than join it.
  publish(panel('outline', 'Outline'))
  await mountInRow()

  const wrappers = dom.container.querySelectorAll('[data-slot="sidebar-wrapper"]')
  assert.equal(wrappers.length, 1, 'only the page row opens a wrapper')
})

// On a phone the shell's sidebar is a sheet over the page, and an App has no
// way to close it. A link pressed inside it, or any other move, must close it,
// or the reader lands on the new page with the sheet still covering it.
import assert from 'node:assert/strict'
import test, { after } from 'node:test'

import { installDomEnvironment } from '@/test-support/dom-environment'

const dom = await installDomEnvironment()

// A phone: the sidebar asks the viewport, and the harness has no media queries.
;(globalThis.window as unknown as { matchMedia: () => unknown }).matchMedia = () => ({
  matches: true,
  addEventListener: () => {},
  removeEventListener: () => {},
})
Object.defineProperty(globalThis.window, 'innerWidth', { configurable: true, value: 390 })

// After the DOM exists, never before — react-dom binds to the globals it finds.
const { act, createElement } = await import('react')
const { createRoot } = await import('react-dom/client')
const { SidebarProvider, useSidebar } = await import('ui/sidebar')
const { useCloseSheetOnChange } = await import('./close-sheet-on-navigate')

after(() => dom.cleanup())

test('a move to another address closes the phone sheet; staying put leaves it open', async () => {
  const seen: { open: boolean; setOpen: (open: boolean) => void } = { open: false, setOpen: () => {} }

  function Harness({ at }: { at: string }) {
    useCloseSheetOnChange(at)
    const sidebar = useSidebar()
    seen.open = sidebar.openMobile
    seen.setOpen = sidebar.setOpenMobile
    return null
  }

  const root = createRoot(dom.container)
  after(() => {
    act(() => root.unmount())
  })
  const render = (at: string) =>
    act(async () => root.render(createElement(SidebarProvider, null, createElement(Harness, { at }))))

  await render('/space/testing/app/tasks/board')
  await act(async () => seen.setOpen(true))
  assert.equal(seen.open, true, 'the sheet opens')

  await render('/space/testing/app/tasks/board')
  assert.equal(seen.open, true, 'a render at the same address leaves it open')

  await render('/space/testing/app/tasks/timeline')
  assert.equal(seen.open, false, 'a move to another address closes it')

  await act(async () => seen.setOpen(true))
  await render('/space/testing/app/tasks/timeline?peek=TASK-4')
  assert.equal(seen.open, false, 'a change of the query alone is a move too')
})

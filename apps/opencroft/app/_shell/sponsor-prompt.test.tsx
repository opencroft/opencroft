// When the monthly prompt is on screen. Mounts the real hook against a real DOM
// and puts other dialogs and ask cards on the page the way the app does, as
// elements carrying a dialog role or an ask card's slot.
//
// NOT COVERED here: that closing the dialog writes the date to the account.
// That is the session wiring above this hook; the server side is pinned by the
// auth package's own suite.
import assert from 'node:assert/strict'
import test, { after, afterEach } from 'node:test'

import { installDomEnvironment } from '@/test-support/dom-environment'

const dom = await installDomEnvironment()
// The hook watches the page with a MutationObserver, which the harness does not
// hand to Node's globals.
const globals = globalThis as unknown as Record<string, unknown>
globals.MutationObserver = window.MutationObserver

const { act, createElement } = await import('react')
const { createRoot } = await import('react-dom/client')
const { usePromptVisibility } = await import('@/app/_shell/sponsor-prompt')

after(() => {
  delete globals.MutationObserver
  dom.cleanup()
})

const unmounts: (() => Promise<void>)[] = []
afterEach(async () => {
  for (const unmount of unmounts.splice(0)) {
    await unmount()
  }
  for (const element of document.querySelectorAll('[data-test-overlay]')) {
    element.remove()
  }
})

interface Probe {
  open: boolean
  close: () => void
}

async function mount(due: boolean): Promise<{ probe: Probe; setDue: (due: boolean) => Promise<void> }> {
  const probe: Probe = { open: false, close: () => {} }
  function Harness({ due }: { due: boolean }) {
    const visibility = usePromptVisibility(due)
    probe.open = visibility.open
    probe.close = visibility.close
    return null
  }
  const root = createRoot(dom.container)
  await act(async () => {
    root.render(createElement(Harness, { due }))
  })
  unmounts.push(async () => {
    await act(async () => {
      root.unmount()
    })
  })
  return {
    probe,
    setDue: async (next) => {
      await act(async () => {
        root.render(createElement(Harness, { due: next }))
      })
    },
  }
}

/** Puts an element on the page the way an open dialog or an ask card appears. */
async function showOverlay(attribute: 'role' | 'data-slot', value: string): Promise<() => Promise<void>> {
  const element = document.createElement('div')
  element.setAttribute(attribute, value)
  element.setAttribute('data-test-overlay', '')
  await act(async () => {
    document.body.append(element)
  })
  return async () => {
    await act(async () => {
      element.remove()
    })
  }
}

test('a due prompt opens when nothing else is on screen', async () => {
  const { probe } = await mount(true)
  assert.equal(probe.open, true)
})

test('a prompt that is not due stays closed', async () => {
  const { probe } = await mount(false)
  assert.equal(probe.open, false)
})

for (const [attribute, value] of [
  ['role', 'dialog'],
  ['role', 'alertdialog'],
  ['data-slot', 'approvals'],
  ['data-slot', 'ask-user-request'],
] as const) {
  test(`a due prompt waits while ${attribute}="${value}" is open, then opens`, async () => {
    const hide = await showOverlay(attribute, value)
    const { probe } = await mount(true)
    assert.equal(probe.open, false, 'it must not open over what is already there')
    await hide()
    assert.equal(probe.open, true, 'it opens once that closes')
  })
}

test('once open, a dialog opening later does not take the prompt down', async () => {
  const { probe } = await mount(true)
  assert.equal(probe.open, true)
  await showOverlay('role', 'dialog')
  assert.equal(probe.open, true)
})

test('a closed prompt stays closed even though it is still due', async () => {
  const { probe } = await mount(true)
  await act(async () => {
    probe.close()
  })
  assert.equal(probe.open, false)
  // Something opening and closing again must not bring it back either.
  const hide = await showOverlay('role', 'dialog')
  await hide()
  assert.equal(probe.open, false)
})

test('an open prompt closes when it stops being due, as when another tab records it seen', async () => {
  const { probe, setDue } = await mount(true)
  assert.equal(probe.open, true)
  await setDue(false)
  assert.equal(probe.open, false)
})

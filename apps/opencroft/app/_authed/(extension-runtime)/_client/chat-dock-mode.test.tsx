// Where the chat panel sits, remembered per App type.
//
// Mounted against a real DOM and unmounted again, because a persistence change
// fails by typechecking perfectly and restoring nothing: leaving a surface and
// coming back is the sequence that has to work.
//
// WHAT THEY DO NOT COVER: that the host provides each surface's App type (the
// App page, the graph canvas). That is wiring above the hook, and only the
// running application shows it.
import assert from 'node:assert/strict'
import test, { after, beforeEach } from 'node:test'

import { installDomEnvironment } from '@/test-support/dom-environment'

const dom = await installDomEnvironment()

// jsdom's own store is unreachable in this harness (the document has no url,
// so its origin is opaque and `window.localStorage` throws); this stands in for
// it, defined rather than assigned because the property is getter-only.
const stored = new Map<string, string>()
Object.defineProperty(globalThis.window, 'localStorage', {
  configurable: true,
  value: {
    getItem: (key: string) => stored.get(key) ?? null,
    setItem: (key: string, value: string) => {
      stored.set(key, value)
    },
    removeItem: (key: string) => {
      stored.delete(key)
    },
    clear: () => {
      stored.clear()
    },
  },
})

// After the DOM exists, never before -- react-dom binds to the globals it finds.
const { act, createElement } = await import('react')
const { createRoot } = await import('react-dom/client')
const { ChatDockAppType, useChatDockMode } = await import('@/app/_authed/(extension-runtime)/_client/chat-dock-mode')
type ChatDockMode = import('@/app/_authed/(extension-runtime)/_client/chat-dock-mode').ChatDockMode

after(() => dom.cleanup())

beforeEach(() => {
  window.localStorage.clear()
})

// Written out rather than imported, so a renamed key fails here instead of
// silently orphaning every reader's stored position.
const SHARED_KEY = 'opencroft.chatDock.mode'

interface Probe {
  mode: ChatDockMode | undefined
  set: (mode: ChatDockMode) => void
}

// One dock's position under one App type (null: no App type around it), kept
// mounted until unmounted.
async function mount(appType: string | null): Promise<{ probe: Probe; unmount: () => Promise<void> }> {
  const probe: Probe = { mode: undefined, set: () => {} }
  function Harness() {
    const [mode, set] = useChatDockMode()
    probe.mode = mode
    probe.set = set
    return null
  }
  const root = createRoot(dom.container)
  await act(async () => {
    root.render(createElement(ChatDockAppType.Provider, { value: appType }, createElement(Harness, null)))
  })
  return {
    probe,
    unmount: async () => {
      await act(async () => {
        root.unmount()
      })
    },
  }
}

async function choose(appType: string | null, mode: ChatDockMode) {
  const dock = await mount(appType)
  await act(async () => {
    dock.probe.set(mode)
  })
  await dock.unmount()
}

async function modeOf(appType: string | null): Promise<ChatDockMode | undefined> {
  const dock = await mount(appType)
  const { mode } = dock.probe
  await dock.unmount()
  return mode
}

test('with nothing remembered, the panel docks right', async () => {
  assert.equal(await modeOf('acme.boards.board'), 'right')
})

test('a position chosen on one App type comes back on it, and only on it', async () => {
  await choose('acme.graphs.graph', 'float')
  await choose('acme.boards.board', 'left')

  assert.equal(await modeOf('acme.graphs.graph'), 'float', 'the first type keeps its own')
  assert.equal(await modeOf('acme.boards.board'), 'left', 'the second type keeps its own')
  assert.equal(await modeOf('acme.notes.notes'), 'right', 'a third type is untouched')
})

test('a type with no position of its own starts from the shared one', async () => {
  // A position stored under the shared key only.
  window.localStorage.setItem(SHARED_KEY, JSON.stringify('bottom'))

  assert.equal(await modeOf('acme.boards.board'), 'bottom')
  await choose('acme.boards.board', 'float')
  assert.equal(await modeOf('acme.boards.board'), 'float', 'its own choice wins once made')
  assert.equal(await modeOf('acme.notes.notes'), 'bottom', 'and other types still start from the shared one')
  assert.equal(window.localStorage.getItem(SHARED_KEY), JSON.stringify('bottom'), 'the shared one is not rewritten')
})

test('a dock outside any App type reads and writes the shared position', async () => {
  await choose(null, 'left')
  assert.equal(window.localStorage.getItem(SHARED_KEY), JSON.stringify('left'))
  assert.equal(await modeOf(null), 'left')
})

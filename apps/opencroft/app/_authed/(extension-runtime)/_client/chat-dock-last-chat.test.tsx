// What the dock remembers, and under which name.
//
// A persistence change fails by typechecking perfectly and restoring nothing, so
// these do not assert that a setter was called. They mount the real hook against
// a real DOM, unmount it, mount it again, and read what comes back -- which is
// the same sequence a reader performs by leaving a surface and returning to it.
//
// WHAT THEY DO NOT COVER, said here rather than left to be discovered: that the
// dock hands this key the space it is mounted for and the account that is signed
// in. That is wiring above the hook, and only the running application shows it.
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import test, { after, beforeEach } from 'node:test'

import { installDomEnvironment } from '@/test-support/dom-environment'

const dom = await installDomEnvironment()

// jsdom's own store is unreachable here: the harness gives the document no url,
// so its origin is opaque and merely touching `window.localStorage` throws. This
// stands in for it -- the same local stub the sidebar suite makes for
// `matchMedia`, and the same limit: it exercises the hook's read and write path
// rather than a browser's storage.
// Defined rather than assigned: `localStorage` is getter-only on the window, so
// a plain assignment throws -- the same reason the harness itself has to define
// `navigator`.
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
const { useLocalStorage } = await import('@/hooks/utils/use-local-storage')

after(() => dom.cleanup())

// The key is written out here rather than imported from the dock, and that is
// not a preference. Importing the dock pulls the whole canvas subtree behind the
// host module and dies on a stylesheet the test runner cannot load -- the same
// coupling that has three other suites red. So the copy below is checked against
// the source instead, by the test that follows it.
const DOCK_SOURCE = new URL('./chat-dock.tsx', import.meta.url)
// A template literal with its placeholders escaped, so what this holds is the
// dock's line as TEXT. Written as a plain string it would read as a placeholder
// this file forgot to interpolate, which is a lint error and a fair reading.
const KEY_TEMPLATE = `return \`opencroft.chatDock.lastChat.\${accountId}.\${space}\``

function lastChatKey(accountId: string, space: string): string {
  return `opencroft.chatDock.lastChat.${accountId}.${space}`
}

test('the copied key is still the key the dock writes', () => {
  // The guard that makes every test below mean something. A duplicated key is a
  // suite that passes while the value is stored where nothing reads it, so this
  // fails the moment the dock's own line changes -- including a reformat, which
  // is the point: a changed key deserves a look rather than a silent pass.
  const source = readFileSync(DOCK_SOURCE, 'utf8')
  assert.ok(source.includes('useLocalStorage'), 'guard against reading an empty or moved file')
  assert.equal(
    source.split(KEY_TEMPLATE).length - 1,
    1,
    'the dock must build its key exactly once, and in the shape copied here',
  )
})

beforeEach(() => {
  window.localStorage.clear()
})

type Selection = { threadId: string } | { newId: string }

/** The last value the mounted hook reported, and its setter while mounted. */
interface Probe {
  value: Selection | undefined
  set: (next: Selection | undefined) => void
}

// One mount of the hook under one key, kept alive until it is unmounted, with
// the hook's own value and setter reachable from the test.
async function mount(key: string): Promise<{ probe: Probe; unmount: () => Promise<void> }> {
  const probe: Probe = { value: undefined, set: () => {} }
  function Harness() {
    const [value, set] = useLocalStorage<Selection | undefined>(key, undefined)
    probe.value = value
    probe.set = set
    return null
  }
  const root = createRoot(dom.container)
  await act(async () => {
    root.render(createElement(Harness, null))
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

test('the key names the account and the space, in that order', () => {
  // The shape itself, because both scopings are load-bearing and a key that
  // dropped either would still be a valid key.
  assert.equal(lastChatKey('acct-1', 'northwind'), 'opencroft.chatDock.lastChat.acct-1.northwind')
})

test('a chosen conversation comes back on the next mount', async () => {
  const key = lastChatKey('acct-1', 'northwind')
  const first = await mount(key)
  assert.equal(first.probe.value, undefined, 'nothing remembered yet')
  await act(async () => {
    first.probe.set({ threadId: 'thread-7' })
  })
  await first.unmount()

  const second = await mount(key)
  assert.deepEqual(second.probe.value, { threadId: 'thread-7' }, 'the conversation is restored, not the default')
  await second.unmount()
})

test('a new chat that was never sent is remembered like any other', async () => {
  // Both shapes of the selection round-trip. A sent new chat is still a `newId`,
  // so a store that only kept explicit thread ids would forget every
  // conversation started from the chooser.
  const key = lastChatKey('acct-1', 'northwind')
  const first = await mount(key)
  await act(async () => {
    first.probe.set({ newId: 'Chat 2026-01-01 09:00:00' })
  })
  await first.unmount()

  const second = await mount(key)
  assert.deepEqual(second.probe.value, { newId: 'Chat 2026-01-01 09:00:00' })
  await second.unmount()
})

test('another space restores its own conversation, not the previous one', async () => {
  const northwind = await mount(lastChatKey('acct-1', 'northwind'))
  await act(async () => {
    northwind.probe.set({ threadId: 'thread-7' })
  })
  await northwind.unmount()

  const other = await mount(lastChatKey('acct-1', 'eastwind'))
  assert.equal(other.probe.value, undefined, 'a space with nothing remembered starts on its default')
  await act(async () => {
    other.probe.set({ threadId: 'thread-9' })
  })
  await other.unmount()

  const back = await mount(lastChatKey('acct-1', 'northwind'))
  assert.deepEqual(back.probe.value, { threadId: 'thread-7' }, 'and the first space still has its own')
  await back.unmount()
})

test('another account does not inherit the conversation', async () => {
  // Why the account is in the key at all: this value points into conversation
  // data, and a thread the second account is not a member of resolves to an
  // unavailable panel rather than to a chat.
  const mine = await mount(lastChatKey('acct-1', 'northwind'))
  await act(async () => {
    mine.probe.set({ threadId: 'thread-7' })
  })
  await mine.unmount()

  const theirs = await mount(lastChatKey('acct-2', 'northwind'))
  assert.equal(theirs.probe.value, undefined)
  await theirs.unmount()
})

test('switching the key while mounted re-reads rather than keeping the old value', async () => {
  // The mechanism the space scoping rests on: the dock does not remount when the
  // reader moves between surfaces, so the restore happens because the hook
  // re-reads when its key changes. A dependency list "corrected" to include the
  // initial value would break this and nothing else would notice.
  window.localStorage.setItem(lastChatKey('acct-1', 'eastwind'), JSON.stringify({ threadId: 'thread-9' }))

  const probe: Probe = { value: undefined, set: () => {} }
  function Harness({ space }: { space: string }) {
    const [value, set] = useLocalStorage<Selection | undefined>(lastChatKey('acct-1', space), undefined)
    probe.value = value
    probe.set = set
    return null
  }
  const root = createRoot(dom.container)
  await act(async () => {
    root.render(createElement(Harness, { space: 'northwind' }))
  })
  assert.equal(probe.value, undefined, 'nothing remembered for the first space')

  await act(async () => {
    root.render(createElement(Harness, { space: 'eastwind' }))
  })
  assert.deepEqual(probe.value, { threadId: 'thread-9' }, 'the second space brings its own')

  await act(async () => {
    root.unmount()
  })
})

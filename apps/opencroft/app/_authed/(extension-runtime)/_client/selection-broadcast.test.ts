// The rules a selection follows between the windows of one browser, over a
// fake channel that delivers like a BroadcastChannel (to every other port,
// never back to the poster) and a clock the test sets.

import assert from 'node:assert/strict'
import test from 'node:test'

import {
  openSelectionBridge,
  parseSelectionMessage,
  type RemoteSelection,
  type SelectionBridge,
  shownSelection,
} from '@/app/_authed/(extension-runtime)/_client/selection-broadcast'
import type { UserSelection } from '@/app/_authed/(extension-runtime)/_client/selection-context'

type Bridge = SelectionBridge
type Remote = RemoteSelection

const NODE: UserSelection = { label: 'Build step', content: 'Node: Build step\nType: script-node\nId: node-1' }
const OTHER_NODE: UserSelection = { label: 'Deploy step', content: 'Node: Deploy step\nType: script-node\nId: node-2' }
const DOC: UserSelection = { label: 'guide.md', content: 'Documentation: docs\nFile: guide.md' }

/** Ports that deliver each post to every other open port, synchronously. */
function makeHub() {
  const ports = new Set<{ deliver: (data: unknown) => void }>()
  const posted: Array<{ from: string; data: unknown }> = []
  const openFor = (name: string) => (onMessage: (data: unknown) => void) => {
    const port = { deliver: onMessage }
    ports.add(port)
    return {
      post: (message: unknown) => {
        posted.push({ from: name, data: message })
        for (const other of ports) {
          if (other !== port) {
            other.deliver(structuredClone(message))
          }
        }
      },
      close: () => {
        ports.delete(port)
      },
    }
  }
  return { openFor, posted }
}

function makeClock(start = 1000) {
  let time = start
  return { now: () => time, set: (next: number) => (time = next) }
}

interface FakeWindow {
  bridge: Bridge
  /** The remote selection as last reported to the window. */
  remote: () => Remote | null
}

function openWindow(
  hub: ReturnType<typeof makeHub>,
  clock: ReturnType<typeof makeClock>,
  source: string,
  space: string,
  local: { selection: UserSelection | null; at: number } | null = null,
): FakeWindow {
  let remote: Remote | null = null
  const bridge = openSelectionBridge({
    space,
    source,
    open: hub.openFor(source),
    now: clock.now,
    onRemote: (next) => {
      remote = next
    },
    local,
  })
  return { bridge, remote: () => remote }
}

test('a selection reaches a window of the same space and not a window of another space', () => {
  const hub = makeHub()
  const clock = makeClock()
  const canvas = openWindow(hub, clock, 'window-a', 'space-1')
  const chat = openWindow(hub, clock, 'window-b', 'space-1')
  const foreign = openWindow(hub, clock, 'window-c', 'space-2')

  canvas.bridge.publish({ selection: NODE, at: 10 })

  assert.deepEqual(chat.remote(), { source: 'window-a', at: 10, selection: NODE })
  assert.equal(foreign.remote(), null)
})

test('the newest selection wins, whichever window made it', () => {
  const hub = makeHub()
  const clock = makeClock()
  const first = openWindow(hub, clock, 'window-a', 'space-1')
  const second = openWindow(hub, clock, 'window-c', 'space-1')
  const chat = openWindow(hub, clock, 'window-b', 'space-1')

  first.bridge.publish({ selection: NODE, at: 10 })
  second.bridge.publish({ selection: DOC, at: 20 })
  assert.deepEqual(chat.remote()?.selection, DOC)

  // Older than what is shown, from another window: it does not replace it.
  first.bridge.publish({ selection: OTHER_NODE, at: 15 })
  assert.deepEqual(chat.remote()?.selection, DOC)

  first.bridge.publish({ selection: OTHER_NODE, at: 30 })
  assert.deepEqual(chat.remote()?.selection, OTHER_NODE)
})

test('a clear empties the chat only when it comes from the window whose selection is shown', () => {
  const hub = makeHub()
  const clock = makeClock()
  const first = openWindow(hub, clock, 'window-a', 'space-1')
  const second = openWindow(hub, clock, 'window-c', 'space-1')
  const chat = openWindow(hub, clock, 'window-b', 'space-1')

  first.bridge.publish({ selection: NODE, at: 10 })
  second.bridge.publish({ selection: DOC, at: 20 })
  first.bridge.publish({ selection: null, at: 30 })
  assert.deepEqual(chat.remote()?.selection, DOC)

  second.bridge.publish({ selection: null, at: 40 })
  assert.deepEqual(chat.remote(), { source: 'window-c', at: 40, selection: null })
})

test('a window opened after the selection asks for it and the selecting window answers', () => {
  const hub = makeHub()
  const clock = makeClock()
  const canvas = openWindow(hub, clock, 'window-a', 'space-1')
  canvas.bridge.publish({ selection: NODE, at: 10 })

  const chat = openWindow(hub, clock, 'window-b', 'space-1')
  assert.equal(chat.remote(), null)
  chat.bridge.announce()

  assert.deepEqual(chat.remote(), { source: 'window-a', at: 10, selection: NODE })
})

test('a window offers only its own selection: what it received is never posted again', () => {
  const hub = makeHub()
  const clock = makeClock()
  const canvas = openWindow(hub, clock, 'window-a', 'space-1')
  const chat = openWindow(hub, clock, 'window-b', 'space-1')
  canvas.bridge.publish({ selection: NODE, at: 10 })
  assert.deepEqual(chat.remote()?.selection, NODE)

  // A third window asks; only the canvas answers, the chat holding NODE as a
  // remote selection stays quiet.
  const late = openWindow(hub, clock, 'window-c', 'space-1')
  late.bridge.announce()

  const fromChat = hub.posted.filter((entry) => entry.from === 'window-b')
  assert.deepEqual(fromChat, [])
  const answers = hub.posted.filter(
    (entry) => entry.from === 'window-a' && (entry.data as { kind: string }).kind === 'selection',
  )
  assert.equal(answers.length, 2)
  assert.deepEqual(late.remote(), { source: 'window-a', at: 10, selection: NODE })
})

test('a window offers its selection to newcomers from the moment it opens, without posting it on opening', () => {
  const hub = makeHub()
  const clock = makeClock()
  const chat = openWindow(hub, clock, 'window-b', 'space-1')
  openWindow(hub, clock, 'window-a', 'space-1', { selection: NODE, at: 10 })

  assert.equal(chat.remote(), null)
  assert.deepEqual(hub.posted, [])

  chat.bridge.announce()
  assert.deepEqual(chat.remote(), { source: 'window-a', at: 10, selection: NODE })
})

test('a window that has nothing selected does not answer', () => {
  const hub = makeHub()
  const clock = makeClock()
  openWindow(hub, clock, 'window-a', 'space-1', { selection: null, at: 10 })
  const chat = openWindow(hub, clock, 'window-b', 'space-1')
  chat.bridge.announce()

  assert.equal(chat.remote(), null)
  assert.deepEqual(
    hub.posted.map((entry) => entry.from),
    ['window-b'],
  )
})

test('leaving clears the selection from the windows showing it, and coming back offers it again', () => {
  const hub = makeHub()
  const clock = makeClock()
  const canvas = openWindow(hub, clock, 'window-a', 'space-1')
  const chat = openWindow(hub, clock, 'window-b', 'space-1')
  canvas.bridge.publish({ selection: NODE, at: 10 })

  clock.set(50)
  canvas.bridge.leave()
  assert.deepEqual(chat.remote(), { source: 'window-a', at: 50, selection: null })

  // Restored from the back-forward cache: the same window offers the same
  // selection under the time it was made, older than its own clear.
  canvas.bridge.rejoin()
  assert.deepEqual(chat.remote(), { source: 'window-a', at: 10, selection: NODE })
})

test('leaving with nothing selected posts nothing', () => {
  const hub = makeHub()
  const clock = makeClock()
  const canvas = openWindow(hub, clock, 'window-a', 'space-1')
  canvas.bridge.leave()
  assert.deepEqual(hub.posted, [])
})

test('a window ignores messages carrying its own id, as a second scope in the same window would post them', () => {
  const hub = makeHub()
  const clock = makeClock()
  const first = openWindow(hub, clock, 'window-a', 'space-1')
  const second = openWindow(hub, clock, 'window-a', 'space-1')

  first.bridge.publish({ selection: NODE, at: 10 })
  second.bridge.announce()

  assert.equal(second.remote(), null)
  assert.equal(first.remote(), null)
})

test('rejoining forgets what the other windows offered before asking again', () => {
  const hub = makeHub()
  const clock = makeClock()
  const canvas = openWindow(hub, clock, 'window-a', 'space-1')
  const chat = openWindow(hub, clock, 'window-b', 'space-1')
  canvas.bridge.publish({ selection: NODE, at: 10 })
  canvas.bridge.close()

  chat.bridge.rejoin()
  assert.equal(chat.remote(), null)
})

test('a closed bridge receives nothing', () => {
  const hub = makeHub()
  const clock = makeClock()
  const canvas = openWindow(hub, clock, 'window-a', 'space-1')
  const chat = openWindow(hub, clock, 'window-b', 'space-1')
  chat.bridge.close()
  canvas.bridge.publish({ selection: NODE, at: 10 })
  assert.equal(chat.remote(), null)
})

test('what is shown is the newer of this window and the others, a tie going to this window', () => {
  const remote = { source: 'window-a', at: 20, selection: NODE }
  assert.equal(shownSelection(null, null), null)
  assert.equal(shownSelection({ selection: DOC, at: 10 }, null), DOC)
  assert.equal(shownSelection(null, remote), NODE)
  assert.equal(shownSelection({ selection: DOC, at: 10 }, remote), NODE)
  assert.equal(shownSelection({ selection: DOC, at: 30 }, remote), DOC)
  assert.equal(shownSelection({ selection: DOC, at: 20 }, remote), DOC)
  // A clear is an event like a selection: a newer clear here hides an older
  // selection from another window, and a newer clear there hides this one's.
  assert.equal(shownSelection({ selection: null, at: 30 }, remote), null)
  assert.equal(shownSelection({ selection: DOC, at: 10 }, { source: 'window-a', at: 20, selection: null }), null)
})

test('only well-formed messages are read, and a selection keeps only its label and content', () => {
  assert.equal(parseSelectionMessage(null), null)
  assert.equal(parseSelectionMessage('hello'), null)
  assert.equal(parseSelectionMessage({ kind: 'hello', space: 'space-1' }), null)
  assert.equal(parseSelectionMessage({ kind: 'selection', space: 'space-1', source: 'w', selection: null }), null)
  assert.equal(
    parseSelectionMessage({ kind: 'selection', space: 'space-1', source: 'w', at: Number.NaN, selection: null }),
    null,
  )
  assert.equal(
    parseSelectionMessage({ kind: 'selection', space: 'space-1', source: 'w', at: 1, selection: { label: 'x' } }),
    null,
  )
  assert.equal(parseSelectionMessage({ kind: 'other', space: 'space-1', source: 'w' }), null)
  assert.deepEqual(parseSelectionMessage({ kind: 'hello', space: 'space-1', source: 'w' }), {
    kind: 'hello',
    space: 'space-1',
    source: 'w',
  })
  assert.deepEqual(
    parseSelectionMessage({
      kind: 'selection',
      space: 'space-1',
      source: 'w',
      at: 1,
      selection: { label: 'x', content: 'y', data: { secret: true } },
    }),
    { kind: 'selection', space: 'space-1', source: 'w', at: 1, selection: { label: 'x', content: 'y' } },
  )
})

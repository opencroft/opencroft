// The selection scope on the channel: what it posts and what it shows, over a
// real BroadcastChannel (Node's), with this file's own channel object standing
// in for the browser's other windows.
//
// The rules themselves are pinned in selection-broadcast.test.ts. What is
// pinned here is the scope's wiring: that a publisher's mount effect, which
// runs before the scope's own, still reaches the channel; that what another
// window posts is what the composer is handed; and that a scope outside a
// space stays off the channel.

import assert from 'node:assert/strict'
import test, { after, afterEach } from 'node:test'

import type { ReactNode } from 'react'

import { installDomEnvironment } from '@/test-support/dom-environment'

const dom = await installDomEnvironment()

const { act, useEffect } = await import('react')
const { createRoot } = await import('react-dom/client')
const { SELECTION_CHANNEL } = await import('@/app/_authed/(extension-runtime)/_client/selection-broadcast')
const { SelectionProvider, SelectionSpace, useSelection } = await import(
  '@/app/_authed/(extension-runtime)/_client/selection-context'
)

type Scope = ReturnType<typeof useSelection>
type UserSelection = NonNullable<Scope['selection']>

const NODE: UserSelection = { label: 'Build step', content: 'Node: Build step\nType: script-node\nId: node-1' }
const DOC: UserSelection = { label: 'guide.md', content: 'Documentation: docs\nFile: guide.md' }
const LATER: UserSelection = { label: 'Later step', content: 'Node: Later step\nType: script-node\nId: node-3' }

// The other windows of the browser.
const others = new BroadcastChannel(SELECTION_CHANNEL)
const heard: Array<Record<string, unknown>> = []
others.onmessage = (event) => {
  heard.push(event.data as Record<string, unknown>)
}

// Every scope still mounted when a test ends, failing ones included: a mounted
// scope holds a channel open, and an open channel keeps the process alive, so a
// failed assertion would otherwise read as a hang rather than a failure.
const mounted = new Set<{ unmount: () => Promise<void> }>()

afterEach(async () => {
  for (const view of [...mounted]) {
    await view.unmount()
  }
})

after(() => {
  others.close()
  witness.close()
  dom.cleanup()
})

// A second listener, standing for one more window: once it has a message, the
// scope's own channel has been handed it in the same delivery round.
const witness = new BroadcastChannel(SELECTION_CHANNEL)
const witnessed: unknown[] = []
witness.onmessage = (event) => {
  witnessed.push(event.data)
}

/**
 * Posts as another window and waits until the post has been delivered and
 * anything it changed has rendered, so a following assertion sees its effect
 * on its own rather than batched with a later post.
 */
async function postAndSettle(message: Record<string, unknown>): Promise<void> {
  const count = witnessed.length
  const sent = JSON.stringify(message)
  others.postMessage(message)
  await until(() => witnessed.slice(count).some((data) => JSON.stringify(data) === sent), 'the post delivered')
  await act(async () => {
    // biome-ignore lint/plugin/noTestFixedTime: fixed settle delay after the post arrives, for the provider to handle it
    await new Promise((resolve) => setTimeout(resolve, 20))
  })
}

/** Waits until `check` holds, for at most two seconds. */
async function until(check: () => boolean, what: string): Promise<void> {
  for (let waited = 0; waited < 2000; waited += 10) {
    if (check()) {
      return
    }
    await act(async () => {
      // biome-ignore lint/plugin/noTestFixedTime: poll interval of a loop capped at a fixed number of tries
      await new Promise((resolve) => setTimeout(resolve, 10))
    })
  }
  assert.fail(`timed out waiting for ${what}`)
}

/** A surface that selects `selection` as it mounts, as the canvas and the document browser do. */
function Publisher({ selection }: { selection: UserSelection }): ReactNode {
  const { setSelection } = useSelection()
  useEffect(() => {
    setSelection(selection)
  }, [selection, setSelection])
  return null
}

async function mount(space: string | null, selection?: UserSelection) {
  let latest: Scope | null = null
  // Each selection the scope showed, in order, without repeats.
  const labels: string[] = []
  function Probe(): ReactNode {
    latest = useSelection()
    const label = latest.selection?.label
    if (label && labels.at(-1) !== label) {
      labels.push(label)
    }
    return null
  }
  const container = dom.container.ownerDocument.createElement('div')
  dom.container.appendChild(container)
  const root = createRoot(container)
  const render = (published: UserSelection | undefined) =>
    act(async () => {
      root.render(
        <SelectionSpace.Provider value={space}>
          <SelectionProvider>
            {published ? <Publisher selection={published} /> : null}
            <Probe />
          </SelectionProvider>
        </SelectionSpace.Provider>,
      )
    })
  await render(selection)
  const view = {
    republish: (next: UserSelection) => render(next),
    shown: () => {
      assert.ok(latest, 'the scope rendered')
      return latest.selection
    },
    labelsShown: () => [...labels],
    unmount: async () => {
      if (!mounted.delete(view)) {
        return
      }
      await act(async () => root.unmount())
      container.remove()
    },
  }
  mounted.add(view)
  return view
}

const selectionsHeard = (space: string) =>
  heard.filter((message) => message.kind === 'selection' && message.space === space)

test('a selection made as the surface mounts is posted for the space, and leaving posts its clear', async () => {
  const view = await mount('space-posting', NODE)
  await until(() => selectionsHeard('space-posting').length > 0, 'the selection on the channel')
  const [posted] = selectionsHeard('space-posting')
  assert.deepEqual(posted?.selection, NODE)
  assert.equal(typeof posted?.source, 'string')

  await act(async () => {
    window.dispatchEvent(new window.Event('pagehide'))
  })
  await until(() => selectionsHeard('space-posting').length > 1, 'the clear on the channel')
  const cleared = selectionsHeard('space-posting')[1]
  assert.equal(cleared?.selection, null)
  assert.equal(cleared?.source, posted?.source)
  await view.unmount()
})

test("another window's selection in the same space is what the scope shows, and its clear takes it away", async () => {
  const view = await mount('space-showing')
  // The scope asked on opening.
  await until(() => heard.some((message) => message.kind === 'hello' && message.space === 'space-showing'), 'the hello')

  others.postMessage({ kind: 'selection', space: 'space-showing', source: 'window-a', at: Date.now(), selection: DOC })
  await until(() => view.shown()?.label === DOC.label, 'the remote selection shown')
  assert.deepEqual(view.shown(), DOC)

  others.postMessage({ kind: 'selection', space: 'space-showing', source: 'window-a', at: Date.now(), selection: null })
  await until(() => view.shown() === null, 'the remote clear')
  await view.unmount()
})

test("another space's selection is not shown", async () => {
  const view = await mount('space-mine')
  await postAndSettle({ kind: 'selection', space: 'space-theirs', source: 'window-a', at: Date.now(), selection: DOC })
  assert.equal(view.shown(), null)
  // The control: a message for this space does arrive and is shown.
  others.postMessage({ kind: 'selection', space: 'space-mine', source: 'window-a', at: Date.now(), selection: LATER })
  await until(() => view.shown() !== null, 'the same-space control')
  assert.deepEqual(view.shown(), LATER)
  assert.deepEqual(view.labelsShown(), [LATER.label])
  await view.unmount()
})

test('a selection from another window older than the one made here is not shown, and a newer one is', async () => {
  const view = await mount('space-newest', NODE)
  await until(() => view.shown()?.label === NODE.label, 'the local selection shown')
  await postAndSettle({ kind: 'selection', space: 'space-newest', source: 'window-a', at: 1, selection: DOC })
  assert.deepEqual(view.shown(), NODE)
  // The control: a newer post from the same window, which does replace it.
  others.postMessage({
    kind: 'selection',
    space: 'space-newest',
    source: 'window-a',
    at: Date.now() + 60_000,
    selection: LATER,
  })
  await until(() => view.shown()?.label === LATER.label, 'the newer remote selection')
  assert.deepEqual(view.labelsShown(), [NODE.label, LATER.label])
  await view.unmount()
})

test('a surface republishing the selection it already holds does not outrank a newer one from another window', async (t) => {
  // The scope stamps its selections with `Date.now`; the test sets the time.
  let time = 1000
  t.mock.method(Date, 'now', () => time)
  const view = await mount('space-republish', NODE)
  await until(() => view.shown()?.label === NODE.label, 'the local selection shown')
  others.postMessage({ kind: 'selection', space: 'space-republish', source: 'window-a', at: 2000, selection: DOC })
  await until(() => view.shown()?.label === DOC.label, 'the remote selection shown')

  // The canvas re-runs its publishing effect on a fresh but equal object, at a
  // time later than the other window's selection.
  time = 3000
  await view.republish({ ...NODE })
  await postAndSettle({ kind: 'hello', space: 'space-republish-settle', source: 'window-a' })
  assert.deepEqual(view.shown(), DOC)
  // The control: a later post from the other window is still shown.
  others.postMessage({ kind: 'selection', space: 'space-republish', source: 'window-a', at: 4000, selection: LATER })
  await until(() => view.shown()?.label === LATER.label, 'the later remote selection')
  assert.deepEqual(view.labelsShown(), [NODE.label, DOC.label, LATER.label])
  await view.unmount()
})

test('a scope outside a space posts nothing', async () => {
  const before = heard.length
  const outside = await mount(null, DOC)
  assert.deepEqual(outside.shown(), DOC, 'the local selection is still shown')
  // The control: a scope inside a space, mounted after, is heard. Posts from
  // one window arrive in order, so the quiet scope's post would come first.
  const inside = await mount('space-control', NODE)
  await until(() => selectionsHeard('space-control').length > 0, 'the control scope on the channel')
  const since = heard.slice(before)
  assert.equal(
    since.some(
      (message) => message.kind === 'selection' && (message.selection as UserSelection | null)?.label === DOC.label,
    ),
    false,
  )
  await outside.unmount()
  await inside.unmount()
})

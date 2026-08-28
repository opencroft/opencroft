// The kit's shared row inside the context menu a chat row actually wraps it in,
// in a real DOM.
//
// This is the composition that broke in the shipped build: `ChatListItem` hands `ListRow`
// to `<ContextMenuTrigger asChild>`, Radix clones the child and injects
// `onContextMenu` onto it, and a child that destructures a fixed prop list and
// spreads nothing drops that handler on the floor. The trigger is then wired to
// nothing and the menu never opens -- no error, no warning, and the row still
// selects on click, so the row itself looks fine.
//
// Nothing that ran caught it and nothing that ran could have. Prop-by-prop
// equality of the row's public surface is structurally blind here, because the
// props ARE identical -- what changed is what they are attached to, an element
// before the extraction and a component after it. `asChild` composition is not
// expressible in the types, so typecheck has nothing to say. And the design-kit
// preview renders the row on its own, never inside a trigger, so the kit's own
// validation does not exercise the composition at all.
//
// The check that discriminates therefore has to put the row inside the trigger
// and watch a real event reach a real DOM node. Both tests below fail against a
// `ListRow` that spreads nothing: the first with the menu never opening, the
// second with the injected ref, attribute and handler all landing nowhere.
//
// This lives in the app workspace rather than beside the component because the
// app's tsconfig.test.json deliberately claims packages/ui source for exactly
// this -- rendering a shared component under a runner that has a DOM. See the
// comment in that file.

import assert from 'node:assert/strict'
import test, { after } from 'node:test'

import type { ReactNode } from 'react'

import { installDomEnvironment } from '@/test-support/dom-environment'

const dom = await installDomEnvironment()

// An open menu reaches for more of the platform than the shared helper puts on
// the global object, and every one of these exists in a browser -- so supplying
// them is describing the real environment, not faking a result.
//
// The two kinds are worth telling apart. ResizeObserver is genuinely absent
// from jsdom, so it is stubbed; the rest exist on the jsdom window and are
// merely not copied onto `globalThis`, so they are bridged from it. Bridging
// rather than using Node's own is the load-bearing part for the event
// constructors: jsdom's `dispatchEvent` rejects an event built from Node's
// global `CustomEvent` as "not of type Event", and Radix builds several while
// the menu opens.
class FakeResizeObserver {
  observe() {}
  unobserve() {}
  disconnect() {}
}

const win = globalThis.window as unknown as Record<string, unknown>
const globals = globalThis as unknown as Record<string, unknown>

globals.ResizeObserver = FakeResizeObserver
win.ResizeObserver = FakeResizeObserver
for (const name of ['Event', 'CustomEvent', 'MouseEvent', 'KeyboardEvent', 'DOMRect', 'MutationObserver']) {
  globals[name] = win[name]
}
globals.getComputedStyle = (win.getComputedStyle as (...args: unknown[]) => unknown).bind(win)

const { act, createRef } = await import('react')
const { createRoot } = await import('react-dom/client')
const { ListRow } = await import('ui/components/ui/utils/list-row')
const { RowContextMenu } = await import('ui/components/ui/utils/row-context-menu')

after(() => dom.cleanup())

async function mount(node: ReactNode) {
  const root = createRoot(dom.container)
  await act(async () => {
    root.render(node)
  })
  return {
    unmount: async () => {
      await act(async () => {
        root.unmount()
      })
    },
  }
}

// The row element itself -- the one a wrapping trigger has to attach to.
function rowElement(): HTMLElement {
  const row = dom.container.querySelector('[role="button"]')
  assert.ok(row, 'the row rendered')
  return row as HTMLElement
}

async function rightClick(target: HTMLElement) {
  await act(async () => {
    target.dispatchEvent(new (win.MouseEvent as typeof MouseEvent)('contextmenu', { bubbles: true, cancelable: true }))
  })
}

test('right-clicking a row inside a context-menu trigger opens the menu', async () => {
  const opened: boolean[] = []
  const { unmount } = await mount(
    <RowContextMenu
      entries={[{ label: 'Move to new folder', onSelect: () => {} }]}
      onOpenChange={(open) => opened.push(open)}
    >
      <ListRow title='A thread' />
    </RowContextMenu>,
  )

  try {
    await rightClick(rowElement())

    assert.deepEqual(opened, [true], 'the trigger saw the right-click and opened its menu')
    assert.match(
      dom.container.ownerDocument.body.textContent ?? '',
      /Move to new folder/,
      'the menu entry is on the screen',
    )
  } finally {
    await unmount()
  }
})

test('a row puts the props and the ref an asChild trigger injects onto its own element', async () => {
  const ref = createRef<HTMLDivElement>()
  const injected: string[] = []
  const { unmount } = await mount(
    <ListRow ref={ref} title='A thread' data-injected='reached' onContextMenu={() => injected.push('handler')} />,
  )

  try {
    const row = rowElement()

    assert.equal(ref.current, row, 'an injected ref reaches the row element')
    assert.equal(row.getAttribute('data-injected'), 'reached', 'an injected attribute reaches the row element')

    await rightClick(row)
    assert.deepEqual(injected, ['handler'], 'an injected handler reaches the row element')
  } finally {
    await unmount()
  }
})

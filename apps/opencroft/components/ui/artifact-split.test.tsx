// The kit's artifact split in a real DOM: where the threshold falls, what each
// arrangement puts on screen -- panes, and one header row per visible pane with
// the surface's controls on the rightmost -- that the pixel minimums hold, and
// that crossing the threshold never remounts the conversation.
//
// jsdom lays nothing out, so two browser services are stood in here, and both
// are written to be exactly as capable as the assertions need:
//
// - ResizeObserver is absent from jsdom. The stand-in records what each
//   observer watches, and `resizeContainer` delivers one entry per watched
//   element carrying the width under test -- the component's own observer and
//   the panel group's both hear it, as they would from a real resize.
// - offsetWidth is zero for everything. The panel group sizes itself from its
//   panels' offsetWidth, so the stand-in answers with the flex formula for the
//   styles the library actually wrote: every panel has a zero basis, so a
//   visible panel's width is the container, less each visible divider, shared
//   in proportion to the panels' inline flex-grow. A hidden panel measures
//   zero. So a width asserted below is the width the rendered styles produce,
//   not a number the component reported about itself.
//
// Lives in the app workspace for the same reason the dock panel's test does:
// the app's tsconfig.test.json claims packages/ui source for rendering under a
// runner that has a DOM.

import assert from 'node:assert/strict'
import test, { after } from 'node:test'

import type { ReactNode } from 'react'

import { installDomEnvironment } from '@/test-support/dom-environment'

const dom = await installDomEnvironment()

const win = globalThis.window as unknown as Record<string, unknown> & typeof window
const globals = globalThis as unknown as Record<string, unknown>

let containerWidth = 0

type Callback = (entries: unknown[], observer: FakeResizeObserver) => void
const observers = new Set<FakeResizeObserver>()

class FakeResizeObserver {
  readonly targets = new Set<Element>()
  constructor(readonly callback: Callback) {
    observers.add(this)
  }
  observe(target: Element) {
    this.targets.add(target)
  }
  unobserve(target: Element) {
    this.targets.delete(target)
  }
  disconnect() {
    this.targets.clear()
    observers.delete(this)
  }
}

globals.ResizeObserver = FakeResizeObserver
win.ResizeObserver = FakeResizeObserver as unknown as typeof ResizeObserver
for (const name of ['Event', 'CustomEvent', 'MouseEvent', 'KeyboardEvent', 'DOMRect', 'MutationObserver']) {
  globals[name] = win[name]
}
globals.getComputedStyle = (win.getComputedStyle as (...args: unknown[]) => unknown).bind(win)

function isShown(element: Element): boolean {
  return !(element as HTMLElement).hidden
}

function renderedWidth(element: HTMLElement): number {
  if (!isShown(element) || !element.parentElement) {
    return 0
  }
  if (element.getAttribute('role') === 'separator') {
    return SPLIT_DIVIDER_WIDTH
  }
  if (!element.hasAttribute('data-panel')) {
    return 0
  }
  const siblings = Array.from(element.parentElement.children) as HTMLElement[]
  const panels = siblings.filter((sibling) => sibling.hasAttribute('data-panel') && isShown(sibling))
  const dividers = siblings.filter((sibling) => sibling.getAttribute('role') === 'separator' && isShown(sibling))
  const grow = (panel: HTMLElement) => Number.parseFloat(panel.style.flexGrow || '1')
  const total = panels.reduce((sum, panel) => sum + grow(panel), 0)
  return ((containerWidth - dividers.length * SPLIT_DIVIDER_WIDTH) * grow(element)) / total
}

// The group orders its children by where they sit before pairing each divider
// with the panels either side, so position has to follow the row as well.
function renderedLeft(element: HTMLElement): number {
  let left = 0
  let sibling = element.previousElementSibling as HTMLElement | null
  while (sibling) {
    left += renderedWidth(sibling)
    sibling = sibling.previousElementSibling as HTMLElement | null
  }
  return left
}

Object.defineProperty(win.HTMLElement.prototype, 'offsetWidth', {
  configurable: true,
  get() {
    return renderedWidth(this as HTMLElement)
  },
})
Object.defineProperty(win.HTMLElement.prototype, 'offsetLeft', {
  configurable: true,
  get() {
    return renderedLeft(this as HTMLElement)
  },
})

const { act, useEffect } = await import('react')
const { createRoot } = await import('react-dom/client')
const { ARTIFACT_SPLIT_MIN_WIDTH, ArtifactSplit, SPLIT_DIVIDER_WIDTH, SPLIT_PANE_MIN_WIDTH, splitFits } = await import(
  'ui/components/ui/group-chat/artifact-split'
)

after(() => dom.cleanup())

async function resizeContainer(width: number) {
  containerWidth = width
  await act(async () => {
    for (const observer of Array.from(observers)) {
      const entries = Array.from(observer.targets).map((target) => ({
        target,
        contentRect: { width, height: 400 },
        borderBoxSize: [{ inlineSize: width, blockSize: 400 }],
        contentBoxSize: [{ inlineSize: width, blockSize: 400 }],
      }))
      if (entries.length > 0) {
        observer.callback(entries, observer)
      }
    }
  })
}

async function mount() {
  const root = createRoot(dom.container)
  const render = async (node: ReactNode) => {
    await act(async () => {
      root.render(node)
    })
  }
  return {
    render,
    unmount: async () => {
      await act(async () => {
        root.unmount()
      })
    },
  }
}

const NOTE = { id: 'a1', title: 'Migration plan', content: 'Three passes.' }

let conversationMounts = 0

// Stands in for the live conversation: counts its mounts, and carries an
// uncontrolled input the way the composer carries a half-written draft.
function Conversation() {
  useEffect(() => {
    conversationMounts++
  }, [])
  return <input aria-label='Draft' defaultValue='' />
}

const HEADER_CLASS = 'h-[45px] px-2 py-1'

let headerPresses: string[] = []

// The split as a host uses it: a chat header, the surface's own control as
// `trailing`, a fixed-height row class, and a pointer handler on the rows.
function Split({
  artifact,
  onClose,
  children,
}: {
  artifact: typeof NOTE | null
  onClose: () => void
  children: ReactNode
}) {
  return (
    <ArtifactSplit
      artifact={artifact}
      onClose={onClose}
      headerClassName={HEADER_CLASS}
      onHeaderPointerDown={(event) =>
        headerPresses.push((event.currentTarget.closest('[data-panel]') as HTMLElement).id)
      }
      header={<span>Chat header</span>}
      trailing={
        <button type='button' aria-label='Close the window'>
          x
        </button>
      }
    >
      {children}
    </ArtifactSplit>
  )
}

function panel(id: 'conversation' | 'artifact'): HTMLElement | null {
  return dom.container.querySelector(`[data-panel][id="${id}"]`)
}

function headerRows(): HTMLElement[] {
  return Array.from(dom.container.querySelectorAll('[data-slot="artifact-split-header"]'))
}

// A row on screen: not inside a hidden pane.
function visibleHeaderRows(): HTMLElement[] {
  return headerRows().filter((row) => !(row.closest('[data-panel]') as HTMLElement).hidden)
}

// Identity of DOM nodes, asserted without handing the nodes to assert: a
// failing assert.equal formats both sides, and formatting a jsdom node walks
// its whole document -- the run stalls to a timeout instead of failing.
function same(actual: unknown, expected: unknown, message: string) {
  assert.ok(actual === expected, message)
}

function trailingButton(): HTMLElement {
  const found = dom.container.querySelectorAll('button[aria-label="Close the window"]')
  assert.equal(found.length, 1, 'the surface control is drawn exactly once')
  return found[0] as HTMLElement
}

function separator(): HTMLElement | null {
  return dom.container.querySelector('[role="separator"]')
}

function button(label: string): HTMLElement | null {
  return dom.container.querySelector(`button[aria-label="${label}"], button[title="${label}"]`)
}

async function press(element: HTMLElement, key: string) {
  await act(async () => {
    element.dispatchEvent(new win.KeyboardEvent('keydown', { key, bubbles: true, cancelable: true }))
  })
}

// Layout percentages are rounded to three decimals, so a pixel width read back
// from them can sit a hair either side of the exact figure.
const TOLERANCE = 0.05

test('the split threshold is the first container step holding two phone-width panes and the divider, and 768 px is the first width that splits', () => {
  assert.equal(SPLIT_PANE_MIN_WIDTH, 375)
  assert.equal(ARTIFACT_SPLIT_MIN_WIDTH, 48 * 16, '48rem, the @3xl container step')
  const needed = 2 * SPLIT_PANE_MIN_WIDTH + SPLIT_DIVIDER_WIDTH
  assert.ok(ARTIFACT_SPLIT_MIN_WIDTH >= needed, 'room for both panes at a phone’s width and the divider')
  assert.ok(42 * 16 < needed, 'the step below, @2xl, would not hold them')
  assert.equal(splitFits(767), false, '767 px covers')
  assert.equal(splitFits(768), true, '768 px splits')
  assert.equal(splitFits(0), false, 'an unmeasured container is narrow')
})

test('at 768 px the note opens beside the conversation, each a phone’s width or more', async () => {
  const { render, unmount } = await mount()
  try {
    await render(
      <Split artifact={NOTE} onClose={() => {}}>
        <Conversation />
      </Split>,
    )
    await resizeContainer(768)

    const conversation = panel('conversation')
    const artifact = panel('artifact')
    const divider = separator()
    assert.ok(conversation && artifact && divider, 'both panels and the divider rendered')
    assert.equal(conversation.hidden, false, 'the conversation is shown')
    assert.equal(divider.hidden, false, 'the divider is shown')
    assert.notEqual(divider.getAttribute('aria-disabled'), 'true', 'and it can be moved')
    assert.ok(
      conversation.offsetWidth >= SPLIT_PANE_MIN_WIDTH - TOLERANCE,
      `conversation ${conversation.offsetWidth}px`,
    )
    assert.ok(artifact.offsetWidth >= SPLIT_PANE_MIN_WIDTH - TOLERANCE, `artifact ${artifact.offsetWidth}px`)
    assert.ok(button('Close'), 'the note closes from its own header')
    same(button('Back'), null, 'and has no Back: the conversation is right beside it')

    // One header row per pane, both on screen, drawn from one class and each
    // leading its pane -- so the two sit on the same top edge at the same
    // height, and the divider between the panes runs through the headers.
    const rows = visibleHeaderRows()
    assert.equal(rows.length, 2, 'a header row for each pane')
    same(rows[0].closest('[data-panel]'), conversation, 'the first is the conversation’s')
    same(rows[1].closest('[data-panel]'), artifact, 'the second is the note’s')
    assert.equal(rows[0].className, rows[1].className, 'drawn from the same class')
    assert.match(rows[0].className, /h-\[45px\]/, 'which carries the host’s fixed height')
    for (const row of rows) {
      same(row.parentElement?.firstElementChild, row, 'at the very top of its pane')
    }
    same(divider.parentElement, conversation.parentElement, 'the divider is the panes’ sibling, full height')
    assert.ok(artifact.textContent?.includes(NOTE.title), 'the note’s header names it')
    assert.equal(rows[1].querySelector('[title="Migration plan"]') !== null, true, 'with the whole name on hover')

    // The surface's controls end the rightmost header.
    same(trailingButton().closest('[data-slot="artifact-split-header"]'), rows[1], 'in the note’s row')
    same(rows[1].lastElementChild, trailingButton(), 'at its very end')

    // Every row answers the host's pointer handler, so a window dragged by its
    // header can be dragged by either.
    headerPresses = []
    for (const row of rows) {
      await act(async () => {
        // jsdom has no PointerEvent; React routes by the event's type.
        row.dispatchEvent(new win.MouseEvent('pointerdown', { bubbles: true, cancelable: true }))
      })
    }
    assert.deepEqual(headerPresses, ['conversation', 'artifact'])
  } finally {
    await unmount()
  }
})

test('with no note open the conversation’s header is the only row, and ends in the surface’s controls', async () => {
  const { render, unmount } = await mount()
  try {
    await render(
      <Split artifact={null} onClose={() => {}}>
        <Conversation />
      </Split>,
    )
    for (const width of [900, 400]) {
      await resizeContainer(width)
      const rows = visibleHeaderRows()
      assert.equal(rows.length, 1, `one header row at ${width}px`)
      same(rows[0].closest('[data-panel]'), panel('conversation'), 'the conversation’s')
      same(rows[0].lastElementChild, trailingButton(), 'ending in the surface’s controls')
      same(separator(), null, 'and no divider')
    }
  } finally {
    await unmount()
  }
})

test('the surface’s controls move to the note’s header when it opens, and back when it closes', async () => {
  const { render, unmount } = await mount()
  try {
    const tree = (artifact: typeof NOTE | null) => (
      <Split artifact={artifact} onClose={() => {}}>
        <Conversation />
      </Split>
    )
    await render(tree(null))
    await resizeContainer(900)
    same(trailingButton().closest('[data-panel]'), panel('conversation'), 'closed: on the conversation')
    await render(tree(NOTE))
    same(trailingButton().closest('[data-panel]'), panel('artifact'), 'split: on the note, the rightmost')
    await resizeContainer(500)
    same(trailingButton().closest('[data-panel]'), panel('artifact'), 'in place: still on the note')
    await render(tree(null))
    same(trailingButton().closest('[data-panel]'), panel('conversation'), 'closed again: back')
  } finally {
    await unmount()
  }
})

test('below 768 px the note takes the conversation’s place, with Back, the conversation hidden but mounted', async () => {
  const closed: string[] = []
  const { render, unmount } = await mount()
  try {
    await render(
      <Split artifact={NOTE} onClose={() => closed.push('closed')}>
        <Conversation />
      </Split>,
    )
    await resizeContainer(767)

    const conversation = panel('conversation')
    const artifact = panel('artifact')
    const divider = separator()
    assert.ok(conversation, 'the conversation is still in the document')
    assert.ok(conversation.querySelector('input[aria-label="Draft"]'), 'with its content')
    assert.equal(conversation.hidden, true, 'but hidden')
    assert.ok(artifact, 'the note rendered')
    assert.equal(artifact.offsetWidth, 767, 'and fills the container alone')
    assert.ok(divider, 'the divider stays in the tree')
    assert.equal(divider.hidden, true, 'hidden')
    assert.equal(divider.getAttribute('aria-disabled'), 'true', 'and disabled, so nothing can resize a hidden panel')
    assert.equal(divider.getAttribute('data-separator'), 'disabled')
    same(button('Close'), null, 'no Close beside the title')

    // The note replaces the conversation header and all: one row on screen,
    // the note's, leading with Back and ending in the surface's controls.
    const rows = visibleHeaderRows()
    assert.equal(rows.length, 1, 'one header row on screen')
    same(rows[0].closest('[data-panel]'), artifact, 'the note’s')
    const chatRow = headerRows().find((row) => row.closest('[data-panel]') === conversation)
    assert.ok(chatRow, 'the conversation’s header is still in the tree')
    assert.ok(chatRow.textContent?.includes('Chat header'))
    assert.equal(conversation.hidden, true, 'hidden with its pane')
    same(rows[0].firstElementChild?.firstElementChild, button('Back'), 'Back leads the note’s row')
    same(rows[0].lastElementChild, trailingButton(), 'and the surface’s controls end it')

    const back = button('Back')
    assert.ok(back, 'Back leads the note instead')
    await act(async () => {
      back.dispatchEvent(new win.MouseEvent('click', { bubbles: true, cancelable: true }))
    })
    assert.deepEqual(closed, ['closed'], 'and Back closes the note')
  } finally {
    await unmount()
  }
})

test('neither side can be resized below its pixel minimum', async () => {
  const { render, unmount } = await mount()
  try {
    await render(
      <Split artifact={NOTE} onClose={() => {}}>
        <Conversation />
      </Split>,
    )
    await resizeContainer(900)
    const conversation = panel('conversation')
    const artifact = panel('artifact')
    const divider = separator()
    assert.ok(conversation && artifact && divider)

    // The keyboard is the separator's own resize path, through the same
    // constraint check a drag goes through: Home asks for the first panel's
    // smallest size, End for the second's, and the arrows step past them.
    await press(divider, 'Home')
    await press(divider, 'ArrowLeft')
    assert.ok(
      Math.abs(conversation.offsetWidth - SPLIT_PANE_MIN_WIDTH) <= TOLERANCE,
      `the conversation stops at ${SPLIT_PANE_MIN_WIDTH}px, measured ${conversation.offsetWidth}px`,
    )

    await press(divider, 'End')
    await press(divider, 'ArrowRight')
    assert.ok(
      Math.abs(artifact.offsetWidth - SPLIT_PANE_MIN_WIDTH) <= TOLERANCE,
      `the note stops at ${SPLIT_PANE_MIN_WIDTH}px, measured ${artifact.offsetWidth}px`,
    )
  } finally {
    await unmount()
  }
})

test('crossing the threshold either way keeps the same conversation mounted, draft and all', async () => {
  conversationMounts = 0
  const { render, unmount } = await mount()
  try {
    const tree = (
      <Split artifact={NOTE} onClose={() => {}}>
        <Conversation />
      </Split>
    )
    await render(tree)
    await resizeContainer(900)

    const input = dom.container.querySelector('input[aria-label="Draft"]') as HTMLInputElement | null
    assert.ok(input)
    input.value = 'half-written reply'

    await resizeContainer(500)
    assert.equal(panel('conversation')?.hidden, true, 'narrow: the note covers the conversation')
    await resizeContainer(900)
    assert.equal(panel('conversation')?.hidden, false, 'wide again: side by side')
    await resizeContainer(500)

    // Closing and reopening the note is the other way the arrangement changes.
    await render(
      <Split artifact={null} onClose={() => {}}>
        <Conversation />
      </Split>,
    )
    assert.equal(panel('conversation')?.hidden, false, 'closed: the conversation is back')
    await render(tree)

    assert.equal(conversationMounts, 1, 'mounted once, never again')
    const after = dom.container.querySelector('input[aria-label="Draft"]')
    same(after, input, 'the very same element')
    assert.equal((after as HTMLInputElement).value, 'half-written reply', 'still holding what was typed')
  } finally {
    await unmount()
  }
})

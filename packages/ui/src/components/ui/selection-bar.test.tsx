// The selection bar through its real gestures: a press on a button, `⋮`
// turning the bar into its list, a group opened in the list and left again,
// and where the bar sits. When it shows is exercised through the hosts that
// feed it a selection: the markdown editor's field and a chat transcript.

import assert from 'node:assert/strict'
import { after, afterEach, before, test } from 'node:test'

import { JSDOM } from 'jsdom'
import { Bold, Heading, Italic, Strikethrough } from 'lucide-react'

import type { SelectionBarMenu } from './selection-bar'

const dom = new JSDOM('<!doctype html><html><body><div id="root"></div></body></html>', {
  url: 'http://localhost/',
  pretendToBeVisual: true,
})

const globals = globalThis as unknown as Record<string, unknown>
const savedGlobals = new Map<string, PropertyDescriptor | undefined>()
// What React, the popover and its positioning reach for.
const NAMES = [
  'window',
  'document',
  'HTMLElement',
  'Element',
  'Node',
  'MouseEvent',
  'PointerEvent',
  'FocusEvent',
  'KeyboardEvent',
  'Event',
  'DOMRect',
  'AbortController',
  'AbortSignal',
  'getComputedStyle',
  'requestAnimationFrame',
  'cancelAnimationFrame',
]

let React: typeof import('react')
let createRoot: typeof import('react-dom/client').createRoot
let SelectionBar: typeof import('./selection-bar').SelectionBar
let root: import('react-dom/client').Root | null = null
let container: HTMLElement

before(async () => {
  for (const name of [...NAMES, 'navigator', 'ResizeObserver', 'IS_REACT_ACT_ENVIRONMENT']) {
    savedGlobals.set(name, Object.getOwnPropertyDescriptor(globalThis, name))
  }
  for (const name of NAMES) {
    Object.defineProperty(globalThis, name, {
      value: (dom.window as unknown as Record<string, unknown>)[name],
      configurable: true,
      writable: true,
    })
  }
  Object.defineProperty(globalThis, 'navigator', { value: dom.window.navigator, configurable: true })
  globals.ResizeObserver = class {
    observe() {}
    unobserve() {}
    disconnect() {}
  }
  globals.IS_REACT_ACT_ENVIRONMENT = true
  React = await import('react')
  ;({ createRoot } = await import('react-dom/client'))
  ;({ SelectionBar } = await import('./selection-bar'))
  container = dom.window.document.getElementById('root') as HTMLElement
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

afterEach(async () => {
  const current = root
  root = null
  if (current) {
    await React.act(async () => current.unmount())
  }
})

const MORE: SelectionBarMenu = [
  [{ id: 'strike', label: 'Strikethrough', icon: Strikethrough, onSelect() {} }],
  [
    {
      id: 'headings',
      label: 'Headings',
      icon: Heading,
      runs: [[{ id: 'h1', label: 'Heading 1', checked: true, onSelect() {} }]],
    },
  ],
]

async function mount(
  chosen: string[],
  { touch = false, more = MORE }: { touch?: boolean; more?: SelectionBarMenu } = {},
) {
  const next = createRoot(container)
  root = next
  const withChoices: SelectionBarMenu = more.map((run) =>
    run.map((entry) =>
      'runs' in entry
        ? {
            ...entry,
            runs: entry.runs.map((r) => r.map((action) => ({ ...action, onSelect: () => chosen.push(action.id) }))),
          }
        : { ...entry, onSelect: () => chosen.push(entry.id) },
    ),
  )
  await React.act(async () =>
    next.render(
      <SelectionBar
        open
        anchor={container}
        touch={touch}
        actions={[
          { id: 'bold', label: 'Bold', icon: Bold, checked: true, onSelect: () => chosen.push('bold') },
          { id: 'italic', label: 'Italic', icon: Italic, checked: false, onSelect: () => chosen.push('italic') },
        ]}
        more={withChoices}
      />,
    ),
  )
}

function bar(): HTMLElement {
  const found = dom.window.document.querySelector<HTMLElement>('[aria-label="Selection"]')
  assert.ok(found, 'the bar is open')
  return found
}

/** The bar's buttons or the list's rows, by their names. */
function names(): string[] {
  return [...bar().querySelectorAll('button')].map((each) => each.getAttribute('aria-label') ?? each.textContent ?? '')
}

function button(name: string): HTMLElement {
  const found = [...bar().querySelectorAll<HTMLElement>('button')].find(
    (each) => (each.getAttribute('aria-label') ?? each.textContent) === name,
  )
  assert.ok(found, `a button "${name}"`)
  return found
}

async function press(element: HTMLElement) {
  await React.act(async () => {
    element.click()
  })
}

test('the bar draws its actions by their icons, named by their labels, then More', async () => {
  await mount([])
  assert.deepEqual(names(), ['Bold', 'Italic', 'More'])
  const buttons = [...bar().querySelectorAll('button')]
  assert.ok(
    buttons.every((each) => each.querySelector('svg') && each.textContent === ''),
    'icons, no text',
  )
  assert.ok(button('More').querySelector('svg.lucide-ellipsis-vertical'), 'More is drawn as vertical dots')
})

test('an action marked showLabel shows its label beside its icon, at the bar height', async () => {
  for (const touch of [false, true]) {
    const next = createRoot(container)
    root = next
    await React.act(async () =>
      next.render(
        <SelectionBar
          open
          anchor={container}
          touch={touch}
          actions={[{ id: 'bold', label: 'Bold', icon: Bold, showLabel: true, onSelect() {} }]}
        />,
      ),
    )
    const shown = button('Bold')
    assert.equal(shown.textContent, 'Bold')
    assert.ok(shown.querySelector('svg'), 'and its icon')
    assert.ok(shown.classList.contains(touch ? 'h-10' : 'h-8'), 'as tall as an icon button')
    root = null
    await React.act(async () => next.unmount())
  }
})

test('a bar with nothing more to list has no More', async () => {
  await mount([], { more: [] })
  assert.deepEqual(names(), ['Bold', 'Italic'])
})

test("a toggle's state shows as pressed", async () => {
  await mount([])
  assert.equal(button('Bold').getAttribute('aria-pressed'), 'true')
  assert.equal(button('Italic').getAttribute('aria-pressed'), 'false')
})

test('no press in the bar takes focus, and a button runs its action', async () => {
  const chosen: string[] = []
  await mount(chosen)
  for (const name of ['Italic', 'More']) {
    const down = new dom.window.MouseEvent('mousedown', { bubbles: true, cancelable: true })
    button(name).dispatchEvent(down)
    assert.equal(down.defaultPrevented, true, `a press on ${name} does not take focus from the text`)
  }
  await press(button('Italic'))
  assert.deepEqual(chosen, ['italic'])
})

test('More turns the bar into its list; a group opens in place and Back leaves it', async () => {
  await mount([])
  await press(button('More'))
  assert.deepEqual(names(), ['Strikethrough', 'Headings'])
  const down = new dom.window.MouseEvent('mousedown', { bubbles: true, cancelable: true })
  button('Headings').dispatchEvent(down)
  assert.equal(down.defaultPrevented, true, 'a press on a row does not take focus either')
  await press(button('Headings'))
  assert.deepEqual(names(), ['Back', 'Heading 1'])
  assert.equal(button('Heading 1').getAttribute('aria-pressed'), 'true')
  await press(button('Back'))
  assert.deepEqual(names(), ['Strikethrough', 'Headings'])
})

test('a choice in the list runs it and turns the list back into the bar', async () => {
  const chosen: string[] = []
  await mount(chosen)
  await press(button('More'))
  await press(button('Headings'))
  await press(button('Heading 1'))
  assert.deepEqual(chosen, ['h1'])
  assert.deepEqual(names(), ['Bold', 'Italic', 'More'])
})

test('the bar sits above the selection with a mouse, compact', async () => {
  await mount([])
  assert.equal(bar().getAttribute('data-side'), 'top')
  assert.ok(!button('Bold').classList.contains('min-h-11'))
})

test('on a touch screen the bar sits below the selection, every button and row 44px', async () => {
  await mount([], { touch: true })
  assert.equal(bar().getAttribute('data-side'), 'bottom')
  for (const each of bar().querySelectorAll('button')) {
    assert.ok(each.classList.contains('min-h-11') && each.classList.contains('min-w-11'), 'a 44px button')
  }
  await press(button('More'))
  for (const each of bar().querySelectorAll('button')) {
    assert.ok(each.classList.contains('min-h-11'), 'a 44px row')
  }
})

// A phone-sized viewport for the positioning, which jsdom does not lay out:
// the bar is BAR_HEIGHT tall and its list `listHeight`.
const VIEWPORT = { width: 400, height: 800 }
const BAR_HEIGHT = 52
// The popover's room kept clear at the viewport's edges.
const COLLISION_PADDING = 5

async function withPhoneLayout(listHeight: number, run: () => Promise<void>) {
  const html = dom.window.document.documentElement
  const proto = dom.window.HTMLElement.prototype
  const saved = ['offsetWidth', 'offsetHeight'].map(
    (name) => [name, Object.getOwnPropertyDescriptor(proto, name)] as const,
  )
  const barIn = (element: HTMLElement) =>
    element.matches('[data-selection-bar]') ? element : element.querySelector('[data-selection-bar]')
  Object.defineProperty(html, 'clientWidth', { value: VIEWPORT.width, configurable: true })
  Object.defineProperty(html, 'clientHeight', { value: VIEWPORT.height, configurable: true })
  Object.defineProperty(proto, 'offsetWidth', {
    configurable: true,
    get(this: HTMLElement) {
      return barIn(this) ? 200 : 0
    },
  })
  Object.defineProperty(proto, 'offsetHeight', {
    configurable: true,
    get(this: HTMLElement) {
      const found = barIn(this)
      if (!found) {
        return 0
      }
      return found.querySelector('[data-slot="selection-bar-row"]') ? listHeight : BAR_HEIGHT
    },
  })
  try {
    await run()
  } finally {
    for (const [name, descriptor] of saved) {
      if (descriptor) {
        Object.defineProperty(proto, name, descriptor)
      }
    }
    delete (html as unknown as Record<string, unknown>).clientWidth
    delete (html as unknown as Record<string, unknown>).clientHeight
  }
}

/** Mounts a touch bar against a selection whose box starts `top` px down. */
async function mountTouchAt(top: number) {
  const next = createRoot(container)
  root = next
  const selection = { getBoundingClientRect: () => new dom.window.DOMRect(100, top, 80, 20) }
  await React.act(async () =>
    next.render(
      <SelectionBar
        open
        anchor={selection}
        touch
        actions={[{ id: 'bold', label: 'Bold', icon: Bold, onSelect() {} }]}
        more={MORE}
      />,
    ),
  )
  await positioned()
}

/**
 * Lets the popover place itself again. A browser does when the bar grows into
 * its list; this one has no ResizeObserver, so a window resize stands in.
 */
async function positioned() {
  await React.act(async () => {
    dom.window.dispatchEvent(new dom.window.Event('resize'))
  })
  for (let i = 0; i < 3; i += 1) {
    await React.act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 0))
    })
  }
}

function availableHeight(): string {
  const positioner = bar().parentElement as HTMLElement
  return positioner.style.getPropertyValue('--available-height')
}

test('below the selection, the list grows down from where the bar was, never over the selection', async () => {
  const { SELECTION_BAR_BELOW_HANDLES, SELECTION_BAR_ABOVE_CALLOUT } = await import('./selection-bar')
  const top = 500
  const below = VIEWPORT.height - (top + 20) - SELECTION_BAR_BELOW_HANDLES - COLLISION_PADDING
  const above = top - SELECTION_BAR_ABOVE_CALLOUT - COLLISION_PADDING
  // Taller than the room below and shorter than the room above, where the
  // platform's own menu is.
  const listHeight = 400
  assert.ok(listHeight > below && listHeight < above)
  await withPhoneLayout(listHeight, async () => {
    await mountTouchAt(top)
    assert.equal(bar().getAttribute('data-side'), 'bottom')
    await press(button('More'))
    await positioned()
    assert.deepEqual(names(), ['Strikethrough', 'Headings'], 'the list is open')
    assert.equal(bar().getAttribute('data-side'), 'bottom', 'it stays below')
    assert.equal(availableHeight(), `${below}px`, 'and scrolls within the room below')
  })
})

test('above the selection, the list grows up from where the bar was, never over the selection', async () => {
  const { SELECTION_BAR_ABOVE_CALLOUT } = await import('./selection-bar')
  // At the bottom of the screen, as a chat's composer: no room for the bar below.
  const top = 740
  const above = top - SELECTION_BAR_ABOVE_CALLOUT - COLLISION_PADDING
  await withPhoneLayout(900, async () => {
    await mountTouchAt(top)
    assert.equal(bar().getAttribute('data-side'), 'top', 'the bar went above')
    await press(button('More'))
    await positioned()
    assert.deepEqual(names(), ['Strikethrough', 'Headings'], 'the list is open')
    assert.equal(bar().getAttribute('data-side'), 'top', 'it stays above')
    assert.equal(availableHeight(), `${above}px`, 'and scrolls within the room above')
  })
})

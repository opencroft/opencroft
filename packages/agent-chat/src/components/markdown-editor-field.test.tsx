// The editor's field look through its real gestures: the flat field, a
// right-click left to the browser, a spelling replacement and a paste made
// from the browser's menu, and the selection bar: when it opens and closes,
// what it offers and where it sits. The toolbar look's toolbar is checked
// beside it, since both read one list of actions.

import assert from 'node:assert/strict'
import { afterEach, before, test } from 'node:test'

import { installTestDom } from '../test-dom'

let root: import('react-dom/client').Root | null = null
let container: HTMLElement
let act: typeof import('react').act
let createRoot: typeof import('react-dom/client').createRoot
let MarkdownEditor: typeof import('./markdown-editor').MarkdownEditor

/** Whether the main pointer is a finger, read as the editor mounts. */
let touchScreen = false

before(async () => {
  container = installTestDom()
  const globals = globalThis as unknown as Record<string, unknown>
  // What the menu primitives, ProseMirror's DOM observer and the table's cell
  // menu reach for beyond the shared test DOM.
  for (const name of [
    'DOMRect',
    'AbortController',
    'AbortSignal',
    'PointerEvent',
    'FocusEvent',
    'MutationObserver',
    'HTMLTableCellElement',
  ]) {
    globals[name] = (window as unknown as Record<string, unknown>)[name]
  }
  globals.ResizeObserver = class {
    observe() {}
    disconnect() {}
  }
  // The bar is placed against the selection, which ProseMirror measures
  // through a Range; jsdom lays nothing out, so a Range has no boxes to give.
  window.Range.prototype.getClientRects = () => [] as unknown as DOMRectList
  window.Range.prototype.getBoundingClientRect = () => new window.DOMRect()
  // jsdom has no media queries: a desktop with a mouse, or a touch screen
  // where a test says so.
  window.matchMedia = ((query: string) => ({
    matches: query === '(pointer: coarse)' && touchScreen,
    media: query,
    addEventListener() {},
    removeEventListener() {},
  })) as unknown as typeof window.matchMedia
  // jsdom has no clipboard events or data; ProseMirror's paste reads only these.
  class TestDataTransfer {
    private data: Record<string, string> = {}
    get types() {
      return Object.keys(this.data)
    }
    files = []
    setData(type: string, value: string) {
      this.data[type] = value
    }
    getData(type: string) {
      return this.data[type] ?? ''
    }
  }
  class TestClipboardEvent extends window.Event {
    clipboardData: TestDataTransfer | null
    constructor(type: string, init: EventInit & { clipboardData?: TestDataTransfer } = {}) {
      super(type, init)
      this.clipboardData = init.clipboardData ?? null
    }
  }
  globals.DataTransfer = TestDataTransfer
  globals.ClipboardEvent = TestClipboardEvent
  ;({ act } = await import('react'))
  ;({ createRoot } = await import('react-dom/client'))
  ;({ MarkdownEditor } = await import('./markdown-editor'))
})

async function unmount() {
  const current = root
  root = null
  if (current) {
    await act(async () => current.unmount())
  }
}

afterEach(async () => {
  await unmount()
  touchScreen = false
})

async function settle() {
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 0))
  })
}

async function mount(markdown: string, variant: 'toolbar' | 'field' = 'field'): Promise<string[]> {
  await unmount()
  const next = createRoot(container)
  root = next
  const changes: string[] = []
  await act(async () => {
    next.render(<MarkdownEditor variant={variant} value={markdown} onChange={(value) => changes.push(value)} />)
  })
  await settle()
  return changes
}

function mountedEditor(): import('@tiptap/core').Editor {
  const element = container.querySelector('.ProseMirror') as
    | (HTMLElement & { editor?: import('@tiptap/core').Editor })
    | null
  assert.ok(element?.editor, 'the editor is mounted')
  return element.editor
}

function text(): HTMLElement {
  return container.querySelector('.ProseMirror') as HTMLElement
}

/** Gives the text focus, as a click into it would. */
async function focusText() {
  const editor = mountedEditor()
  await act(async () => {
    editor.commands.focus('end')
    // The editor takes focus on the next animation frame.
    await new Promise((resolve) => setTimeout(resolve, 50))
  })
  assert.ok(editor.isFocused, 'the text has focus')
}

/** The position of the first occurrence of `fragment` in the document. */
function positionOf(fragment: string): number {
  let from = -1
  mountedEditor().state.doc.descendants((node, pos) => {
    if (from < 0 && node.isText && node.text?.includes(fragment)) {
      from = pos + node.text.indexOf(fragment)
    }
  })
  assert.ok(from >= 0, `the document holds "${fragment}"`)
  return from
}

/** Selects the first occurrence of `fragment`, as Shift+arrows or a drag would. */
async function select(fragment: string) {
  const from = positionOf(fragment)
  await act(async () => {
    mountedEditor().commands.setTextSelection({ from, to: from + fragment.length })
  })
  await settle()
}

/** A right-click on `target`; whether the browser's own menu may open. */
async function rightClick(target: HTMLElement = text()): Promise<boolean> {
  let notCancelled = true
  await act(async () => {
    target.dispatchEvent(new window.PointerEvent('pointerdown', { bubbles: true, button: 2, pointerType: 'mouse' }))
    notCancelled = target.dispatchEvent(new window.MouseEvent('contextmenu', { bubbles: true, cancelable: true, button: 2 }))
    target.dispatchEvent(new window.PointerEvent('pointerup', { bubbles: true, button: 2, pointerType: 'mouse' }))
  })
  await settle()
  return notCancelled
}

/** The open menus' rows, by their text. */
function rows(): string[] {
  return [...document.querySelectorAll('[role="menuitem"], [role="menuitemcheckbox"]')].map(
    (row) => row.getAttribute('aria-label') ?? row.textContent ?? '',
  )
}

/** The selection bar's element; null while it is closed. */
function barElement(): HTMLElement | null {
  return document.querySelector<HTMLElement>('[aria-label="Selection"]')
}

/** The selection bar, by its buttons' names; null while it is closed. */
function bar(): string[] | null {
  const found = barElement()
  return found ? [...found.querySelectorAll('button')].map((button) => button.getAttribute('aria-label') ?? '') : null
}

function barButton(label: string): HTMLElement {
  const found = barElement()?.querySelector<HTMLElement>(`button[aria-label="${label}"]`)
  assert.ok(found, `a bar button "${label}"`)
  return found
}

async function press(element: HTMLElement) {
  await act(async () => {
    element.dispatchEvent(new window.PointerEvent('pointerdown', { bubbles: true, button: 0, pointerType: 'mouse' }))
    element.dispatchEvent(new window.MouseEvent('mousedown', { bubbles: true, cancelable: true }))
    element.dispatchEvent(new window.PointerEvent('pointerup', { bubbles: true, button: 0, pointerType: 'mouse' }))
    element.dispatchEvent(new window.MouseEvent('mouseup', { bubbles: true }))
    element.click()
  })
  await settle()
}

async function key(name: string, target: HTMLElement = text()): Promise<KeyboardEvent> {
  const event = new window.KeyboardEvent('keydown', { bubbles: true, cancelable: true, key: name })
  await act(async () => {
    target.dispatchEvent(event)
  })
  await settle()
  return event
}

test('the field is flat: no toolbar and no input frame around its text', async () => {
  await mount('Hello')
  assert.equal(container.querySelector('button[title="Bold"]'), null)
  assert.ok(text().closest('[data-slot="markdown-editor-field"]'), 'the text sits in the field')
  assert.equal(text().closest('[data-slot="input-group"]'), null)
})

test("the toolbar look's toolbar offers the same buttons in the same order", async () => {
  await mount('Hello', 'toolbar')
  const titles = [...container.querySelectorAll('button[title]')].map((button) => button.getAttribute('title'))
  assert.deepEqual(titles, [
    'Undo',
    'Redo',
    'Bold',
    'Italic',
    'Strikethrough',
    'Inline code',
    'Clear formatting',
    'Heading 1',
    'Heading 2',
    'Heading 3',
    'Bullet list',
    'Numbered list',
    'Blockquote',
    'Code block',
    'Horizontal rule',
    'Link',
    'Remove link',
    'Hint',
    'Sections',
    'Insert',
  ])
  assert.equal(container.querySelector('[data-slot="input-group"]'), null)
})

test("a right-click in the field is left to the browser's own menu", async () => {
  await mount('Helo world')
  await focusText()
  await select('Helo')
  assert.equal(await rightClick(), true, 'the contextmenu event is not cancelled')
  assert.deepEqual(rows(), [], 'no menu of the editor opens')
})

test("a right-click in a table cell is left to the browser's menu in the field", async () => {
  await mount('| Name | Role |\n| --- | --- |\n| Ada | Lead |')
  await focusText()
  const cell = text().querySelector('td') as HTMLElement
  assert.equal(await rightClick(cell), true, 'the contextmenu event is not cancelled')
  assert.deepEqual(rows(), [])
})

test("a right-click in a table cell opens the table's menu in the toolbar look", async () => {
  await mount('| Name | Role |\n| --- | --- |\n| Ada | Lead |', 'toolbar')
  const cell = text().querySelector('td') as HTMLElement
  assert.equal(await rightClick(cell), false, 'the contextmenu event is cancelled')
  assert.ok(rows().includes('Delete table'), "the table's menu is open")
})

test("a spelling replacement the browser makes in the text reaches the editor's value", async () => {
  const changes = await mount('Helo world')
  await focusText()
  // What the browser does when a suggestion from its menu is picked: it
  // replaces the word in the editable text, which the editor reads back.
  const word = [...text().querySelectorAll('p')].flatMap((p) => [...p.childNodes]).find((node) => node.nodeType === 3)
  assert.ok(word, 'the paragraph has its text')
  await act(async () => {
    text().dispatchEvent(
      new window.InputEvent('beforeinput', { bubbles: true, cancelable: true, inputType: 'insertReplacementText' }),
    )
    ;(word as Text).data = 'Hello world'
    await new Promise((resolve) => setTimeout(resolve, 50))
  })
  await settle()
  assert.equal(changes.at(-1), 'Hello world')
})

test("a paste from the browser's menu reads markdown text as markdown, as Ctrl+V does", async () => {
  const changes = await mount('Hello ')
  await focusText()
  const data = new (globalThis as unknown as { DataTransfer: new () => DataTransfer }).DataTransfer()
  data.setData('text/plain', '**there**')
  await act(async () => {
    text().dispatchEvent(
      new (globalThis as unknown as { ClipboardEvent: typeof ClipboardEvent }).ClipboardEvent('paste', {
        bubbles: true,
        cancelable: true,
        clipboardData: data,
      }),
    )
  })
  await settle()
  assert.equal(changes.at(-1), 'Hello **there**')
})

test('selected text gets the bar: Bold, Italic, Inline code, Link, Clear formatting and More', async () => {
  await mount('Hello world')
  await focusText()
  assert.equal(bar(), null, 'a caret alone gets no bar')
  await select('world')
  assert.deepEqual(bar(), ['Bold', 'Italic', 'Inline code', 'Link', 'Clear formatting', 'More'])
})

// What `⋮` lists, read from the menu the bar is given: the table's actions are
// checked here entry by entry, the list itself through the bar further down.
async function moreMenu() {
  const { fullMenu } = await import('./markdown-editor-field-menus')
  const { actionStates, EDITOR_ACTIONS } = await import('./markdown-editor-actions')
  const { tableAtCaret } = await import('./markdown-editor-table')
  const editor = mountedEditor() as unknown as import('@tiptap/react').Editor
  return fullMenu(editor, actionStates(editor, Object.values(EDITOR_ACTIONS).flat()), undefined, tableAtCaret(editor.state))
}

type Entry = import('ui/components/ui/selection-bar').SelectionBarEntry
type Action = import('ui/components/ui/selection-bar').SelectionBarAction

function labels(runs: Entry[][]): string[][] {
  return runs.map((run) => run.map((entry) => entry.label))
}

async function tableEntry(label: string): Promise<Action> {
  const table = (await moreMenu()).flat().find((entry) => entry.id === 'table')
  assert.ok(table && 'runs' in table, 'the menu has a Table submenu')
  const found = table.runs.flat().find((action) => action.label === label)
  assert.ok(found, `Table offers "${label}"`)
  return found
}

test('More lists what the bar lacks: the other styles, the block styles, link and hint actions, then the groups', async () => {
  await mount('Hello world')
  await select('world')
  assert.deepEqual(labels(await moreMenu()), [
    ['Strikethrough', 'Bullet list', 'Numbered list', 'Blockquote', 'Code block', 'Horizontal rule', 'Remove link', 'Hint'],
    ['Headings'],
    ['Sections', 'Insert'],
    [],
  ])
})

test('no action is both on the bar and in More, at any depth', async () => {
  await mount('| Name | Role |\n| --- | --- |\n| Ada | Lead |')
  await focusText()
  await select('Lead')
  const onBar = new Set(bar())
  const inMore = (await moreMenu())
    .flat()
    .flatMap((entry) => ('runs' in entry ? [entry.label, ...entry.runs.flat().map((action) => action.label)] : [entry.label]))
  assert.ok(inMore.length > 0)
  assert.deepEqual(
    inMore.filter((label) => onBar.has(label)),
    [],
  )
})

/** The bar's list, by its rows' names; null while the bar is closed. */
function list(): string[] | null {
  const found = barElement()
  return found
    ? [...found.querySelectorAll('button')].map((row) => row.getAttribute('aria-label') ?? row.textContent ?? '')
    : null
}

function row(label: string): HTMLElement {
  const found = [...(barElement()?.querySelectorAll<HTMLElement>('button') ?? [])].find(
    (each) => (each.getAttribute('aria-label') ?? each.textContent) === label,
  )
  assert.ok(found, `a row "${label}"`)
  return found
}

test('More turns the bar into the list in place, and a group opens in it with a way back', async () => {
  await mount('Hello world')
  await focusText()
  await select('world')
  await press(barButton('More'))
  assert.deepEqual(list(), [
    'Strikethrough',
    'Bullet list',
    'Numbered list',
    'Blockquote',
    'Code block',
    'Horizontal rule',
    'Remove link',
    'Hint',
    'Headings',
    'Sections',
    'Insert',
  ])
  await press(row('Headings'))
  assert.deepEqual(list(), ['Back', 'Heading 1', 'Heading 2', 'Heading 3'])
  await press(row('Back'))
  assert.equal(list()?.[0], 'Strikethrough')
  assert.ok(mountedEditor().isFocused, 'the text keeps focus throughout')
})

test('a choice in the list acts and turns the list back into the bar', async () => {
  const changes = await mount('Hello world')
  await focusText()
  await select('world')
  await press(barButton('More'))
  await press(row('Headings'))
  await press(row('Heading 2'))
  assert.equal(changes.at(-1), '## Hello world')
  assert.deepEqual(bar(), ['Bold', 'Italic', 'Inline code', 'Link', 'Clear formatting', 'More'])
})

test('a block style in the list acts from the top level, with no group to open', async () => {
  const changes = await mount('Hello world')
  await focusText()
  await select('world')
  await press(barButton('More'))
  await press(row('Bullet list'))
  assert.equal(changes.at(-1), '- Hello world')
  assert.deepEqual(bar(), ['Bold', 'Italic', 'Inline code', 'Link', 'Clear formatting', 'More'])
})

test('Clear formatting on the bar clears the styles in the selection', async () => {
  const changes = await mount('Hello **world**')
  await focusText()
  await select('world')
  await press(barButton('Clear formatting'))
  assert.equal(changes.at(-1), 'Hello world')
})

test('a press on a row of the list leaves focus in the text', async () => {
  await mount('Hello world')
  await focusText()
  await select('world')
  await press(barButton('More'))
  const down = new window.MouseEvent('mousedown', { bubbles: true, cancelable: true })
  row('Headings').dispatchEvent(down)
  assert.equal(down.defaultPrevented, true)
})

test('Escape closes the list first, then the bar', async () => {
  await mount('Hello world')
  await focusText()
  await select('world')
  await press(barButton('More'))
  await key('Escape')
  assert.deepEqual(bar(), ['Bold', 'Italic', 'Inline code', 'Link', 'Clear formatting', 'More'], 'the list is the bar again')
  await key('Escape')
  assert.equal(bar(), null)
})

test('a new selection opens the bar, not the list it had open', async () => {
  await mount('Hello world')
  await focusText()
  await select('world')
  await press(barButton('More'))
  const caret = positionOf('world')
  await act(async () => {
    mountedEditor().commands.setTextSelection(caret)
  })
  await settle()
  await select('Hello')
  assert.deepEqual(bar(), ['Bold', 'Italic', 'Inline code', 'Link', 'Clear formatting', 'More'])
})

test("in a table More also offers the table's actions for the selection's cell", async () => {
  await mount('| Name | Role |\n| --- | --- |\n| Ada | Lead |')
  await select('Lead')
  const table = (await moreMenu()).at(-1)?.[0]
  assert.ok(table && 'runs' in table)
  assert.deepEqual(labels(table.runs), [
    ['Insert row above', 'Insert row below'],
    ['Move row up', 'Move row down'],
    ['Delete row'],
    ['Insert column left', 'Insert column right'],
    ['Move column left', 'Move column right'],
    ['Delete column'],
    ['Align left', 'Align center', 'Align right'],
    ['Delete table'],
  ])
  // The cell is in the last row and the last column.
  assert.equal((await tableEntry('Move row down')).disabled, true)
  assert.equal((await tableEntry('Move column right')).disabled, true)
  assert.equal((await tableEntry('Move row up')).disabled, false)
  assert.equal((await tableEntry('Align left')).checked, true)
})

test('a selection in a table cell gets the bar, and the table its grips', async () => {
  await mount('| Name | Role |\n| --- | --- |\n| Ada | Lead |')
  await focusText()
  await select('Lead')
  assert.deepEqual(bar(), ['Bold', 'Italic', 'Inline code', 'Link', 'Clear formatting', 'More'])
  assert.ok(text().querySelector('td'), 'the table is still drawn')
})

test("the table's actions in More act on the selection's row and column", async () => {
  const changes = await mount('| Name | Role |\n| --- | --- |\n| Ada | Lead |')
  await select('Lead')
  await act(async () => (await tableEntry('Align center')).onSelect())
  assert.equal(changes.at(-1), '| Name | Role |\n| --- | :---: |\n| Ada | Lead |')
  await select('Lead')
  await act(async () => (await tableEntry('Move column left')).onSelect())
  assert.equal(changes.at(-1), '| Role | Name |\n| :---: | --- |\n| Lead | Ada |')
  await select('Lead')
  await act(async () => (await tableEntry('Delete table')).onSelect())
  assert.equal(changes.at(-1), '')
})

test('a selection in a field without focus gets no bar', async () => {
  await mount('Hello world')
  await select('world')
  assert.equal(mountedEditor().isFocused, false)
  assert.equal(bar(), null)
})

test('the bar sits above the selection with a mouse', async () => {
  await mount('Hello world')
  await focusText()
  await select('world')
  assert.equal(barElement()?.getAttribute('data-side'), 'top')
})

test('a quick action acts on the selection and shows it is on', async () => {
  const changes = await mount('Hello world')
  await focusText()
  await select('world')
  assert.equal(barButton('Bold').getAttribute('aria-pressed'), 'false')
  await press(barButton('Bold'))
  assert.equal(changes.at(-1), 'Hello **world**')
  assert.equal(barButton('Bold').getAttribute('aria-pressed'), 'true', 'the bar stays, showing Bold on')
  await press(barButton('Italic'))
  assert.equal(changes.at(-1), 'Hello ***world***')
  await press(barButton('Inline code'))
  assert.match(changes.at(-1) ?? '', /`world`/)
})

test('a press on a bar button leaves focus in the text', async () => {
  await mount('Hello world')
  await focusText()
  await select('world')
  const down = new window.MouseEvent('mousedown', { bubbles: true, cancelable: true })
  barButton('Bold').dispatchEvent(down)
  assert.equal(down.defaultPrevented, true)
  const more = new window.MouseEvent('mousedown', { bubbles: true, cancelable: true })
  barButton('More').dispatchEvent(more)
  assert.equal(more.defaultPrevented, true)
})

test('the bar waits for a mouse drag to end before it opens', async () => {
  await mount('Hello world')
  await focusText()
  await act(async () => {
    text().dispatchEvent(new window.PointerEvent('pointerdown', { bubbles: true, button: 0, pointerType: 'mouse' }))
  })
  await select('world')
  assert.equal(bar(), null, 'no bar while the button is down')
  await act(async () => {
    window.dispatchEvent(new window.PointerEvent('pointerup', { bubbles: true, button: 0, pointerType: 'mouse' }))
  })
  await settle()
  assert.ok(bar(), 'the bar opens once the button is up')
})

test('a mouse click on the selection puts the bar away once, and the same text chosen again gets it back', async () => {
  await mount('Hello world')
  await focusText()
  await select('world')
  assert.ok(bar())
  const opened: boolean[] = []
  const observer = new window.MutationObserver(() => {
    const now = barElement() !== null
    if (opened.at(-1) !== now) {
      opened.push(now)
    }
  })
  observer.observe(document.body, { childList: true, subtree: true, attributes: true })
  try {
    await act(async () => {
      text().dispatchEvent(new window.PointerEvent('pointerdown', { bubbles: true, button: 0, pointerType: 'mouse' }))
    })
    await act(async () => {
      window.dispatchEvent(new window.PointerEvent('pointerup', { bubbles: true, button: 0, pointerType: 'mouse' }))
    })
    await settle()
    assert.equal(bar(), null, 'the release leaves the bar away, with the selection still there')
    // The browser clears the selection once the click is over.
    await act(async () => {
      mountedEditor().commands.setTextSelection(1)
    })
    await settle()
    observer.takeRecords()
  } finally {
    observer.disconnect()
  }
  assert.deepEqual(opened, [false], 'closed on the press and never shown again')
  await select('world')
  assert.ok(bar(), 'the same text chosen again opens the bar')
})

test('the bar closes when the selection collapses, as typing over it does', async () => {
  await mount('Hello world')
  await focusText()
  await select('world')
  assert.ok(bar())
  await act(async () => {
    mountedEditor().commands.insertContent('there')
  })
  await settle()
  assert.equal(bar(), null)
})

test('the bar closes when the text loses focus', async () => {
  await mount('Hello world')
  await focusText()
  await select('world')
  assert.ok(bar())
  await act(async () => {
    mountedEditor().commands.blur()
    await new Promise((resolve) => setTimeout(resolve, 50))
  })
  await settle()
  assert.equal(bar(), null)
})

test('Escape closes the bar until the selection changes, and goes no further', async () => {
  await mount('Hello world')
  await focusText()
  await select('world')
  const heard: string[] = []
  const listen = (event: KeyboardEvent) => heard.push(event.key)
  container.addEventListener('keydown', listen)
  try {
    await key('Escape')
    assert.equal(bar(), null, 'Escape closes the bar')
    assert.deepEqual(heard, [], 'the Escape that closed the bar does not reach the host')
    await key('Escape')
    assert.deepEqual(heard, ['Escape'], 'with the bar closed, Escape goes on to the host')
    await select('Hello')
    assert.ok(bar(), 'a new selection opens it again')
  } finally {
    container.removeEventListener('keydown', listen)
  }
})

test('after Escape, choosing the same text again opens the bar', async () => {
  await mount('Hello world')
  await focusText()
  await select('world')
  await key('Escape')
  assert.equal(bar(), null, 'Escape closes the bar')
  const caret = positionOf('world')
  await act(async () => {
    mountedEditor().commands.setTextSelection(caret)
  })
  await settle()
  assert.equal(bar(), null, 'no bar at a bare caret')
  await select('world')
  assert.ok(bar(), 'the same range, chosen again after a click away, opens the bar')
})

test('after Escape, moving to other text and back opens the bar', async () => {
  await mount('Hello world')
  await focusText()
  await select('world')
  await key('Escape')
  await select('Hello')
  assert.ok(bar(), 'other text opens the bar')
  await select('world')
  assert.ok(bar(), 'the text Escape closed it for opens it again')
})

test('after Escape, leaving the text and coming back to the same selection opens the bar', async () => {
  await mount('Hello world')
  await focusText()
  await select('world')
  await key('Escape')
  const editor = mountedEditor()
  await act(async () => {
    editor.commands.blur()
    await new Promise((resolve) => setTimeout(resolve, 50))
  })
  await settle()
  await act(async () => {
    editor.commands.focus()
    await new Promise((resolve) => setTimeout(resolve, 50))
  })
  await settle()
  const { from, to } = editor.state.selection
  assert.equal(editor.state.doc.textBetween(from, to), 'world', 'focus comes back with the same selection')
  assert.ok(bar(), 'the bar opens again')
})

/** Waits out the time a selection must stand still on a touch screen. */
async function waitForSettle() {
  const { SELECTION_BAR_SETTLE_MS } = await import('ui/components/ui/selection-bar')
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, SELECTION_BAR_SETTLE_MS + 50))
  })
}

/** A finger going down on, or coming up from, `target`. */
async function touch(type: 'touchstart' | 'touchend', target: EventTarget = text()) {
  await act(async () => {
    const event = new window.Event(type, { bubbles: true })
    Object.defineProperty(event, 'touches', { value: [] })
    target.dispatchEvent(event)
  })
  await settle()
}

test('on a touch screen the bar waits for the selection to stand still', async () => {
  touchScreen = true
  await mount('Hello world')
  await focusText()
  await select('world')
  assert.equal(bar(), null, 'not while the selection may still be moving')
  await waitForSettle()
  assert.ok(bar(), 'once it has stood still')
  await select('Hello')
  assert.equal(bar(), null, 'a moved selection waits again')
  await waitForSettle()
  assert.ok(bar())
})

test('on a touch screen the bar hides while a finger is down, but not for a press on the bar', async () => {
  touchScreen = true
  await mount('Hello world')
  await focusText()
  await select('world')
  await waitForSettle()
  await touch('touchstart', barButton('Bold'))
  assert.ok(bar(), 'a finger on the bar keeps it')
  await touch('touchend', barButton('Bold'))
  await touch('touchstart')
  assert.equal(bar(), null, 'a finger on the text hides it')
  await touch('touchend')
  assert.equal(bar(), null, 'lifting it does not bring the bar back at once')
  await waitForSettle()
  assert.ok(bar(), 'with the selection unchanged, it comes back once the lift has stood still')
})

test('on a touch screen a tap that clears the selection puts the bar away once', async () => {
  touchScreen = true
  await mount('Hello world')
  await focusText()
  await select('world')
  await waitForSettle()
  const opened: boolean[] = []
  const observer = new window.MutationObserver(() => {
    const now = barElement() !== null
    if (opened.at(-1) !== now) {
      opened.push(now)
    }
  })
  observer.observe(document.body, { childList: true, subtree: true, attributes: true })
  try {
    await touch('touchstart')
    await touch('touchend')
    // The platform clears the selection once the tap is over.
    await act(async () => {
      mountedEditor().commands.setTextSelection(1)
    })
    await waitForSettle()
    observer.takeRecords()
  } finally {
    observer.disconnect()
  }
  assert.equal(bar(), null)
  assert.deepEqual(opened, [false], 'closed on the touch and never shown again')
})

test('on a touch screen the text gives up focus when the keyboard closes', async () => {
  touchScreen = true
  const viewport = Object.assign(new window.EventTarget(), { width: 390, height: 500 })
  const globals = window as unknown as { visualViewport: unknown }
  const original = globals.visualViewport
  globals.visualViewport = viewport
  try {
    await mount('Hello world')
    await focusText()
    const resize = async (width: number, height: number) => {
      await act(async () => {
        Object.assign(viewport, { width, height })
        viewport.dispatchEvent(new window.Event('resize'))
        await new Promise((resolve) => setTimeout(resolve, 50))
      })
    }
    await resize(390, 556)
    assert.ok(mountedEditor().isFocused, "the browser's toolbar coming back is not the keyboard")
    await resize(390, 500)
    // Turned sideways and back with the keyboard up: the visible height grows
    // by more than a keyboard's worth, at another width.
    await resize(844, 200)
    await resize(390, 500)
    assert.ok(mountedEditor().isFocused, 'turning the phone is not the keyboard either')
    await resize(390, 300)
    await resize(390, 600)
    assert.equal(mountedEditor().isFocused, false, 'the keyboard closing takes focus out of the text')
  } finally {
    globals.visualViewport = original
  }
})

test('on a touch screen the bar sits below the selection, sized for a finger', async () => {
  touchScreen = true
  await mount('Hello world')
  await focusText()
  await select('world')
  await waitForSettle()
  assert.deepEqual(bar(), ['Bold', 'Italic', 'Inline code', 'Link', 'Clear formatting', 'More'])
  assert.equal(barElement()?.getAttribute('data-side'), 'bottom')
  for (const button of barElement()?.querySelectorAll('button') ?? []) {
    assert.ok(button.classList.contains('min-h-11') && button.classList.contains('min-w-11'), 'a 44px button')
  }
})

test("on a touch screen the platform's long-press menu is not cancelled", async () => {
  touchScreen = true
  await mount('Hello')
  await focusText()
  let shown = false
  await act(async () => {
    shown = text().dispatchEvent(new window.MouseEvent('contextmenu', { bubbles: true, cancelable: true }))
  })
  await settle()
  assert.equal(shown, true)
})

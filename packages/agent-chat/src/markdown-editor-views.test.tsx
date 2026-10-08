import assert from 'node:assert/strict'
import { after, before, test } from 'node:test'

import { installTestDom } from './test-dom'

// The mounted editor, not a headless one: these tests are about what the
// block views draw and what their controls write back, which only exists once
// React has rendered them.
let root: import('react-dom/client').Root | null = null
let container: HTMLElement
let act: typeof import('react').act
let createRoot: typeof import('react-dom/client').createRoot
let MarkdownEditor: typeof import('./markdown-editor').MarkdownEditor

before(async () => {
  container = installTestDom()
  ;({ act } = await import('react'))
  ;({ MarkdownEditor } = await import('./markdown-editor'))
  ;({ createRoot } = await import('react-dom/client'))
})

async function unmount() {
  const current = root
  root = null
  if (current) {
    await act(async () => current.unmount())
  }
}

after(unmount)

/**
 * Mount a fresh editor on `markdown` and collect what it reports. Fresh each
 * time: an editor kept between tests would carry its caret, and with it which
 * tab it shows, from one test into the next.
 */
async function mount(markdown: string): Promise<string[]> {
  await unmount()
  const next = createRoot(container)
  root = next
  const changes: string[] = []
  await act(async () => {
    next.render(<MarkdownEditor value={markdown} onChange={(value) => changes.push(value)} />)
  })
  // The editor is created after the first render, and its node views after that.
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 0))
  })
  return changes
}

/** Change an input the way a person typing does, so React's onChange fires. */
async function typeInto(input: HTMLInputElement, value: string) {
  const setValue = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value')?.set
  await act(async () => {
    setValue?.call(input, value)
    input.dispatchEvent(new window.Event('input', { bubbles: true }))
  })
}

/** The mounted editor, which TipTap hangs on its own element. */
function mountedEditor(): import('@tiptap/core').Editor {
  const element = container.querySelector('.ProseMirror') as
    | (HTMLElement & { editor?: import('@tiptap/core').Editor })
    | null
  assert.ok(element?.editor, 'the editor is mounted')
  return element.editor
}

function iconPosition(editor: import('@tiptap/core').Editor): number {
  let found = -1
  editor.state.doc.descendants((node, pos) => {
    if (node.type.name === 'markdownIcon') {
      found = pos
    }
  })
  assert.ok(found >= 0, 'the document holds an icon')
  return found
}

function pickerSearch(): HTMLInputElement | null {
  return document.querySelector<HTMLInputElement>('input[aria-label="Search icons"]')
}

async function press(target: Element, key: string) {
  await act(async () => {
    target.dispatchEvent(new window.KeyboardEvent('keydown', { key, bubbles: true }))
  })
}

/** Click or tap the icon itself, the one way its picker opens on an icon already there. */
async function openPicker(): Promise<HTMLInputElement> {
  const icon = document.querySelector('[aria-label^="Icon: "]')
  assert.ok(icon, 'the icon is drawn')
  await pressOn(icon)
  await nextFrame()
  const search = pickerSearch()
  assert.ok(search, 'a click on the icon opens its picker')
  return search
}

test('the caret steps over an icon in one move, like a character, and never opens its picker', async () => {
  await mount('Before :icon[smile] after')
  const editor = mountedEditor()
  const pos = iconPosition(editor)
  await act(async () => {
    editor.chain().focus().setTextSelection(pos).run()
  })
  await nextFrame()
  await press(editor.view.dom, 'ArrowRight')
  assert.deepEqual([editor.state.selection.from, editor.state.selection.to], [pos + 1, pos + 1], 'past it')
  assert.equal(pickerSearch(), null, 'no picker')
  await press(editor.view.dom, 'ArrowLeft')
  assert.deepEqual([editor.state.selection.from, editor.state.selection.to], [pos, pos], 'back before it')
  assert.equal(pickerSearch(), null, 'still no picker')
})

// The browser moves by word and paints a selection by the text it finds; the
// icon's drawing is neither, so the icon carries text of its own for both.
test('an icon carries text for the browser: an emoji, where moving by word stops, then a blank for a selection to paint', async () => {
  await mount('Before :icon[smile] after')
  const editor = mountedEditor()
  const icon = editor.view.nodeDOM(iconPosition(editor)) as HTMLElement
  assert.match(icon.textContent ?? '', /^\p{Extended_Pictographic}\s$/u)
})

test('a caret the browser leaves inside an icon reads as before it at the icon’s start, and after it anywhere else', async () => {
  await mount('Before :icon[smile] after')
  const editor = mountedEditor()
  const pos = iconPosition(editor)
  await act(async () => {
    editor.commands.focus()
  })
  await nextFrame()
  const icon = editor.view.nodeDOM(pos) as HTMLElement
  const walker = document.createTreeWalker(icon, window.NodeFilter.SHOW_TEXT)
  walker.nextNode()
  const emoji = walker.currentNode as Text
  walker.nextNode()
  const blank = walker.currentNode as Text
  // Where Ctrl+arrow leaves the browser's caret: the edges of the icon's emoji.
  const read = async (node: Text, offset: number) => {
    await act(async () => {
      window.getSelection()?.collapse(node, offset)
      document.dispatchEvent(new window.Event('selectionchange'))
    })
    return editor.state.selection.head
  }
  assert.equal(await read(emoji, 0), pos, 'its start is before the icon')
  assert.equal(await read(emoji, emoji.length), pos + 1, 'past the emoji is after it')
  assert.equal(await read(blank, 1), pos + 1, 'its end is after it')
  assert.equal(await read(emoji, 0), pos, 'and back before it')
})

test('Backspace just after an icon, or Delete just before it, removes the whole icon in one press', async () => {
  const changes = await mount('Before :icon[smile] after')
  const editor = mountedEditor()
  const pos = iconPosition(editor)
  await act(async () => {
    editor
      .chain()
      .focus()
      .setTextSelection(pos + 1)
      .run()
  })
  await press(editor.view.dom, 'Backspace')
  assert.equal(changes.at(-1), 'Before  after')
  assert.deepEqual([editor.state.selection.from, editor.state.selection.to], [pos, pos])

  const changesAgain = await mount('Before :icon[smile] after')
  const again = mountedEditor()
  await act(async () => {
    again.chain().focus().setTextSelection(iconPosition(again)).run()
  })
  await press(again.view.dom, 'Delete')
  assert.equal(changesAgain.at(-1), 'Before  after')
})

test('a click on an icon opens its picker; a choice in it keeps it open; Escape returns typing to just after it', async () => {
  const changes = await mount('Before :icon[smile] after')
  const editor = mountedEditor()
  const pos = iconPosition(editor)
  const search = await openPicker()
  assert.equal(document.activeElement, search, 'typing goes into the search')

  await typeInto(search, 'rocket')
  await press(search, 'Enter')
  assert.equal(changes.at(-1), 'Before :icon[rocket] after')
  assert.ok(pickerSearch(), 'the picker is still open for a colour')

  await press(pickerSearch() as HTMLInputElement, 'Escape')
  await nextFrame()
  assert.equal(pickerSearch(), null, 'Escape closes the picker')
  assert.deepEqual(
    [editor.state.selection.from, editor.state.selection.to],
    [pos + 1, pos + 1],
    'the caret is just after the icon',
  )
  assert.ok(
    editor.view.dom.contains(document.activeElement),
    'keyboard focus is back in the text, so typing lands there',
  )
})

test('an icon inserted from the toolbar has its search focused once the toolbar has let go', async () => {
  const changes = await mount('A sentence with ')
  const editor = mountedEditor()
  await act(async () => {
    editor.commands.setTextSelection(editor.state.doc.content.size - 1)
  })
  const blocks = container.querySelector<HTMLButtonElement>('button[title="Insert a block"]')
  assert.ok(blocks, 'the toolbar has its Blocks menu')
  await act(async () => {
    blocks.focus()
  })
  await pressOn(blocks, FULL_CLICK)
  await nextFrame()
  const icon = [...document.querySelectorAll('[role="menuitem"]')].find((item) => item.textContent === 'Icon')
  assert.ok(icon, 'the Blocks menu offers Icon')
  await pressOn(icon, FULL_CLICK)
  // TipTap focuses an unfocused editor a frame later; the picker has to still
  // hold focus after that.
  await nextFrame()
  await nextFrame()
  const search = pickerSearch()
  assert.ok(search, 'the inserted icon has its picker open')
  assert.equal(document.activeElement, search, 'typing goes into the search')
  assert.match(changes.at(-1) ?? '', /:icon\[smile\]/)
})

test('an icon inserted where the editor already has focus, as the / menu does, opens with its search focused', async () => {
  const changes = await mount('A sentence with ')
  const editor = mountedEditor()
  await act(async () => {
    editor
      .chain()
      .focus()
      .setTextSelection(editor.state.doc.content.size - 1)
      .run()
  })
  await nextFrame()
  const { insertIcon } = await import('./markdown-editor-icon')
  await act(async () => {
    insertIcon(editor.chain().focus()).run()
  })
  await nextFrame()
  const search = pickerSearch()
  assert.ok(search, 'the inserted icon has its picker open')
  assert.equal(document.activeElement, search)
  assert.match(changes.at(-1) ?? '', /:icon\[smile\]/)
})

test('an open picker leaves the icon unselected, so text typed beside it never replaces it', async () => {
  const changes = await mount('Before :icon[smile] after')
  const editor = mountedEditor()
  const pos = iconPosition(editor)
  await openPicker()
  assert.equal(editor.state.selection.to - editor.state.selection.from, 0, 'a caret, not the icon selected')
  await act(async () => {
    editor
      .chain()
      .focus()
      .setTextSelection(pos + 1)
      .insertContent('x')
      .run()
  })
  assert.equal(changes.at(-1), 'Before :icon[smile]x after')
})

test('the palette offers every hue, and every shade of the hue in hand, writing the hue and shade back', async () => {
  const changes = await mount('Before :icon[smile] after')
  await openPicker()
  const hues = [...document.querySelectorAll('[role="group"][aria-label="Palette"] button')]
  assert.equal(hues.length, 22, 'every hue of the palette')
  const sky = hues.find((hue) => hue.getAttribute('aria-label') === 'Sky')
  assert.ok(sky)
  await act(async () => {
    ;(sky as HTMLButtonElement).click()
  })
  assert.equal(changes.at(-1), 'Before :icon[smile]{color=sky-500} after', 'a hue starts at its 500')
  const shades = [...document.querySelectorAll('[role="radiogroup"][aria-label="Sky shade"] [role="radio"]')]
  assert.deepEqual(
    shades.map((shade) => shade.getAttribute('aria-label')),
    ['50', '100', '200', '300', '400', '500', '600', '700', '800', '900', '950'].map((shade) => `Sky ${shade}`),
  )
  await act(async () => {
    ;(shades[3] as HTMLButtonElement).click()
  })
  assert.equal(changes.at(-1), 'Before :icon[smile]{color=sky-300} after')
  assert.match(
    document.querySelector('[aria-label^="Icon: "] svg')?.getAttribute('class') ?? '',
    /text-sky-300/,
    'the icon in the text takes the shade',
  )
})

/** The icons on the picker's grid, in order, with the one marked chosen. */
function pickerGrid(): { names: string[]; chosen: string[] } {
  const radios = [...document.querySelectorAll('[role="radiogroup"][aria-label="Icon"] [role="radio"]')]
  return {
    names: radios.map((radio) => radio.getAttribute('aria-label') ?? ''),
    chosen: radios
      .filter((radio) => radio.getAttribute('aria-checked') === 'true')
      .map((radio) => radio.getAttribute('aria-label') ?? ''),
  }
}

test('reopening an icon shows it first on the grid, marked chosen, and a new choice stays where it was clicked', async () => {
  const changes = await mount('Before :icon[smile] after')
  await openPicker()
  const opened = pickerGrid()
  assert.equal(opened.names[0], 'smile', 'the current icon leads the grid')
  assert.deepEqual(opened.chosen, ['smile'])
  assert.equal(opened.names.filter((name) => name === 'smile').length, 1, 'and is not on it twice')

  const other = document.querySelector<HTMLButtonElement>(`[role="radio"][aria-label="${opened.names[1]}"]`)
  assert.ok(other)
  await act(async () => {
    other.click()
  })
  assert.equal(changes.at(-1), `Before :icon[${opened.names[1]}] after`)
  const after = pickerGrid()
  assert.deepEqual(after.names, opened.names, 'the grid does not reorder under the pointer')
  assert.deepEqual(after.chosen, [opened.names[1]])
})

/**
 * A mouse press on `target`, as the popover hears it: it closes on the click
 * of a press that also started outside it. No `mousedown` by default:
 * ProseMirror would place the caret from it, which needs a layout jsdom does
 * not have.
 */
const POINTER_PRESS = ['pointerdown', 'pointerup', 'click']

/** Every event of a click, which the toolbar's menu opens and acts on; for controls outside the text. */
const FULL_CLICK = ['pointerdown', 'mousedown', 'pointerup', 'mouseup', 'click']

async function pressOn(target: Element, events = POINTER_PRESS) {
  await act(async () => {
    for (const type of events) {
      const init = { bubbles: true, cancelable: true, button: 0, pointerType: 'mouse' }
      target.dispatchEvent(
        type.startsWith('pointer') && window.PointerEvent
          ? new window.PointerEvent(type, init)
          : new window.MouseEvent(type, init),
      )
    }
  })
}

/** Let a focus TipTap defers to the next frame happen, if one was asked for. */
async function nextFrame() {
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 50))
  })
}

test('a press in the text closes the picker and leaves the caret to ProseMirror, where the press put it', async () => {
  await mount('Some text\n\n:icon[smile]')
  const editor = mountedEditor()
  await openPicker()
  const paragraph = editor.view.dom.querySelector('p')
  assert.ok(paragraph, 'the text line above the icon')
  // In a browser ProseMirror places the caret from the press itself, and the
  // popover closes on the click after it. jsdom has no layout to place a
  // caret from, so the caret is put where the press would have, and what is
  // left to see is that closing the picker does not move it.
  const clicked = 3
  await act(async () => {
    editor.commands.setTextSelection(clicked)
  })
  await pressOn(paragraph)
  await nextFrame()
  assert.equal(pickerSearch(), null, 'the picker is closed')
  assert.deepEqual([editor.state.selection.from, editor.state.selection.to], [clicked, clicked])
})

test('a press outside the editor closes the picker without taking focus back into the text', async () => {
  await mount('Some text\n\n:icon[smile]')
  const editor = mountedEditor()
  const outside = document.createElement('button')
  document.body.append(outside)
  try {
    await openPicker()
    const before = [editor.state.selection.from, editor.state.selection.to]
    await act(async () => {
      outside.focus()
    })
    await pressOn(outside)
    await nextFrame()
    assert.equal(pickerSearch(), null, 'the picker is closed')
    assert.deepEqual([editor.state.selection.from, editor.state.selection.to], before, 'the caret is not moved')
    assert.equal(document.activeElement, outside, 'focus stays where the press took it')
  } finally {
    outside.remove()
  }
})

test('Remove in the picker deletes the icon and leaves keyboard focus in the text', async () => {
  const changes = await mount('Before :icon[smile] after')
  const editor = mountedEditor()
  await openPicker()
  const remove = [...document.querySelectorAll('button')].find((button) => button.textContent === 'Remove icon')
  assert.ok(remove, 'the open picker offers Remove')
  await act(async () => {
    remove.click()
  })
  await nextFrame()
  assert.equal(changes.at(-1), 'Before  after')
  assert.equal(pickerSearch(), null, 'the picker is gone with its icon')
  assert.ok(editor.view.dom.contains(document.activeElement), 'keyboard focus is in the text')
})

test('the toolbar ends with the Blocks menu, after the buttons it already had', async () => {
  await mount('text')
  const buttons = [...container.querySelectorAll('button')]
  const titles = buttons.map((button) => button.getAttribute('title'))
  assert.ok(titles.includes('Insert table'), 'the existing table button stays')
  assert.ok(titles.includes('Horizontal rule'), 'the existing rule button stays')
  assert.equal(titles.at(-1), 'Insert a block')
  assert.match(buttons.at(-1)?.textContent ?? '', /Blocks/)
})

test('a code block draws in the code block frame, labelled with its language outside the editable code', async () => {
  const changes = await mount('```yaml\nclosing: 19:00\n```\n\n```\nplain\n```')
  const frames = [...container.querySelectorAll<HTMLElement>('.ProseMirror [data-code-frame]')]
  assert.equal(frames.length, 2, 'both code blocks are framed')
  const [named, unnamed] = frames
  const label = named.querySelector<HTMLElement>('[data-code-label]')
  assert.equal(label?.textContent, 'yaml')
  assert.equal(label?.getAttribute('contenteditable'), 'false')
  assert.equal(named.querySelector('pre[data-code-block] code')?.textContent, 'closing: 19:00')
  assert.equal(unnamed.querySelector('[data-code-label]'), null, 'a block naming no language has no label')
  // The label is drawn, not written: the code block's text is its code alone.
  const editor = mountedEditor()
  const texts: string[] = []
  editor.state.doc.descendants((node) => {
    if (node.type.name === 'codeBlock') {
      texts.push(node.textContent)
    }
  })
  assert.deepEqual(texts, ['closing: 19:00', 'plain'])
  assert.deepEqual(changes, [])
})

test('a code block’s label follows its language as the language changes', async () => {
  await mount('```yaml\nclosing: 19:00\n```')
  const editor = mountedEditor()
  await act(async () => {
    editor.chain().setTextSelection(2).updateAttributes('codeBlock', { language: 'json' }).run()
  })
  assert.equal(container.querySelector('[data-code-label]')?.textContent, 'json')
  await act(async () => {
    editor.chain().updateAttributes('codeBlock', { language: null }).run()
  })
  assert.equal(container.querySelector('[data-code-label]'), null)
})

test('a code block’s lines keep the `pre`’s white-space, so a long line scrolls instead of wrapping', async () => {
  await mount('```ts\nexport const line = "a line of code far longer than the editor is wide"\n```')
  const pre = container.querySelector<HTMLElement>('.ProseMirror pre[data-code-block]')
  assert.ok(pre)
  // Every element between the `pre` and the text inherits its white-space;
  // an inline value of its own would outrank the stylesheet's `pre`.
  const between: HTMLElement[] = []
  for (let el = pre.querySelector<HTMLElement>('[data-node-view-content]'); el && el !== pre; ) {
    between.push(el)
    el = el.querySelector<HTMLElement>(':scope > *')
  }
  assert.ok(between.length > 0, 'the code is drawn inside the pre')
  assert.deepEqual(
    between.map((el) => el.style.whiteSpace || 'inherit'),
    between.map(() => 'inherit'),
  )
})

test('a callout draws as the kit callout, and its title field writes the title back', async () => {
  const changes = await mount(':::warning{title="Before"}\nBody.\n:::')
  const title = container.querySelector<HTMLInputElement>('input[aria-label="Callout title"]')
  assert.ok(title, 'the callout heading is an input')
  assert.equal(title.value, 'Before')
  assert.ok(container.querySelector('[role="note"]'))
  await typeInto(title, 'After')
  assert.equal(changes.at(-1), ':::warning{title="After"}\nBody.\n\n:::')
})

test('a spoiler is drawn open, with its summary as a field that writes back', async () => {
  const changes = await mount(':::details{summary="Log"}\nline\n:::')
  assert.equal(container.querySelector('details'), null, 'not a collapsible while being edited')
  const summary = container.querySelector<HTMLInputElement>('input[aria-label="Spoiler summary"]')
  assert.equal(summary?.value, 'Log')
  assert.match(container.textContent ?? '', /line/)
  if (summary) {
    await typeInto(summary, 'Full log')
  }
  assert.equal(changes.at(-1), ':::details{summary="Full log"}\nline\n\n:::')
})

test('tabs draw a strip of their labels, and + adds a tab', async () => {
  const changes = await mount('::::tabs\n:::tab{label="npm"}\na\n:::\n:::tab{label="pnpm"}\nb\n:::\n::::')
  const labels = [...container.querySelectorAll('[role="tab"]')].map((tab) => tab.textContent)
  assert.deepEqual(labels, ['npm', 'pnpm'])
  const add = container.querySelector<HTMLButtonElement>('button[aria-label="Add tab"]')
  assert.ok(add)
  await act(async () => {
    add.click()
  })
  assert.match(changes.at(-1) ?? '', /:::tab\{label="Tab 3"\}/)
})

test('a page opens on the first tab of its tabs, wherever loading left the caret', async () => {
  await mount('Intro.\n\n::::tabs\n:::tab{label="npm"}\na\n:::\n:::tab{label="pnpm"}\nb\n:::\n::::')
  const selected = [...container.querySelectorAll('[role="tab"]')].map((tab) => tab.getAttribute('aria-selected'))
  assert.deepEqual(selected, ['true', 'false'])
})

test('the selected tab can be removed, and the one that takes its place is shown', async () => {
  const changes = await mount('::::tabs\n:::tab{label="npm"}\na\n:::\n:::tab{label="pnpm"}\nb\n:::\n::::')
  const remove = container.querySelector<HTMLButtonElement>('button[aria-label="Remove tab npm"]')
  assert.ok(remove, 'the first tab is selected, and it carries the remove control')
  await act(async () => {
    remove.click()
  })
  assert.equal(changes.at(-1), '::::tabs\n:::tab{label="pnpm"}\nb\n\n:::\n\n::::')
  const labels = [...container.querySelectorAll('[role="tab"]')].map((tab) => tab.textContent)
  assert.deepEqual(labels, ['pnpm'])
  assert.equal(container.querySelector('button[title="Remove tab"]'), null, 'no remove control on the last tab')
})

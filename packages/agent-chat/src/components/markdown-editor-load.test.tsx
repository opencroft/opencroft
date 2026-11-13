import assert from 'node:assert/strict'
import { after, before, test } from 'node:test'

import { installTestDom } from '../test-dom'

// A controlled editor whose `value` changes from outside while it is open: the
// document someone has open, written to by someone else. And where its caret
// is when a key arrives right after a click.
let root: import('react-dom/client').Root | null = null
let container: HTMLElement
let act: typeof import('react').act
let createRoot: typeof import('react-dom/client').createRoot
let MarkdownEditor: typeof import('./markdown-editor').MarkdownEditor
let readMarkdown: typeof import('./markdown-editor').readMarkdown

before(async () => {
  container = installTestDom()
  const globals = globalThis as unknown as Record<string, unknown>
  // A table's view measures itself; nothing here depends on what it measures.
  globals.ResizeObserver = class {
    observe() {}
    unobserve() {}
    disconnect() {}
  }
  // Undo scrolls the caret into view, which asks the layout jsdom does not have.
  const view = window as unknown as { Range: typeof Range; Element: typeof Element }
  const noRects = () => [] as unknown as DOMRectList
  const zeroRect = () => ({ top: 0, left: 0, right: 0, bottom: 0, width: 0, height: 0, x: 0, y: 0 }) as DOMRect
  view.Range.prototype.getClientRects = noRects
  view.Range.prototype.getBoundingClientRect = zeroRect
  view.Element.prototype.getClientRects = noRects
  ;({ act } = await import('react'))
  ;({ MarkdownEditor, readMarkdown } = await import('./markdown-editor'))
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

/** Mount a fresh editor on `markdown`; `render` passes it a new value, as its caller would. */
async function mount(markdown: string) {
  await unmount()
  const next = createRoot(container)
  root = next
  const changes: string[] = []
  const render = (value: string) =>
    act(async () => {
      next.render(<MarkdownEditor value={value} onChange={(changed) => changes.push(changed)} />)
    })
  await render(markdown)
  // The editor is created after the first render, and its node views after that.
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 0))
  })
  const element = container.querySelector('.ProseMirror') as
    | (HTMLElement & { editor?: import('@tiptap/core').Editor })
    | null
  assert.ok(element?.editor, 'the editor is mounted')
  return { editor: element.editor, changes, render }
}

test('a value in another spelling of the same document is opened without reporting an edit', async () => {
  const stored = '# Notes\n\n* one\n* two\n\nSome __bold__ text\nover two lines.\n\n| Name   | Value |\n| :----- | ----: |\n| alpha  | 1     |\n'
  const { editor, changes } = await mount(stored)
  assert.equal(readMarkdown(editor), '# Notes\n\n- one\n- two\n\nSome **bold** text over two lines.\n\n| Name | Value |\n| :--- | ---: |\n| alpha | 1 |')
  assert.deepEqual(changes, [], 'nothing reported, so the stored spelling is kept')
})

test('a value that arrives while the person is typing keeps their caret and is not reported', async () => {
  const { editor, changes, render } = await mount('First paragraph here.\n\nSecond one.')
  await act(async () => {
    // After "First", inside the first paragraph.
    editor.chain().setTextSelection(6).insertContent('X').run()
  })
  assert.deepEqual(changes, ['FirstX paragraph here.\n\nSecond one.'])
  await render(changes[0])

  await render('FirstX paragraph here.\n\nSecond one.\n\nAdded elsewhere.')

  assert.equal(readMarkdown(editor), 'FirstX paragraph here.\n\nSecond one.\n\nAdded elsewhere.')
  assert.equal(editor.state.selection.from, 7, 'the caret stays after what the person typed')
  assert.equal(changes.length, 1, 'the arrival is not reported back as an edit')
  await act(async () => {
    editor.chain().insertContent('Y').run()
  })
  assert.equal(changes.at(-1), 'FirstXY paragraph here.\n\nSecond one.\n\nAdded elsewhere.', 'typing goes on where it was')
})

test('a value that arrives before the caret moves the caret with the text it was in', async () => {
  const { editor, render } = await mount('Alpha beta.')
  await act(async () => {
    // Between "beta" and the full stop.
    editor.chain().setTextSelection(11).run()
  })
  await render('Gamma. Alpha beta.')
  assert.equal(editor.state.selection.from, 18)
})

test('undo reverts the person’s own edit and keeps what arrived since', async () => {
  const { editor, changes, render } = await mount('Mine\n\nTheirs.')
  await act(async () => {
    // At the end of "Mine".
    editor.chain().setTextSelection(5).insertContent('!').run()
  })
  await render(changes[0])
  await render('Mine!\n\nTheirs, edited.')

  await act(async () => {
    editor.commands.undo()
  })

  assert.equal(readMarkdown(editor), 'Mine\n\nTheirs, edited.')
  assert.equal(changes.at(-1), 'Mine\n\nTheirs, edited.', 'the undo is reported as an edit')
})

/** The position just after `text`, which occurs once in the document. */
function endOf(editor: import('@tiptap/core').Editor, text: string): number {
  let found: number | null = null
  editor.state.doc.descendants((node, pos) => {
    const at = node.isText ? (node.text ?? '').indexOf(text) : -1
    if (at >= 0) {
      found = pos + at + text.length
    }
  })
  assert.ok(found !== null, `"${text}" is in the document`)
  return found
}

/** The text of the block the caret is in, split at the caret. */
function caret(editor: import('@tiptap/core').Editor) {
  const { $from } = editor.state.selection
  const text = $from.parent.textContent
  return [text.slice(0, $from.parentOffset), text.slice($from.parentOffset)]
}

// A document whose last block is not a paragraph, which the editor holds with
// an empty paragraph after it.
for (const [ending, last, lastChanged, lastWord] of [
  ['a list', '- one\n- two', '- one\n- two\n- three', 'two'],
  ['a table', '| Name | Value |\n| --- | --- |\n| alpha | two |', '| Name | Value |\n| --- | --- |\n| alpha | two |\n| beta | three |', 'two'],
] as const) {
  test(`in a document ending in ${ending}, a value that arrives before the caret moves the caret with the text it was in`, async () => {
    const { editor, render } = await mount(`Intro.\n\n${last}`)
    await act(async () => {
      // Inside the last word, which is not where the document ends.
      editor.chain().setTextSelection(endOf(editor, lastWord) - 1).run()
    })
    await render(`Intro, longer.\n\n${last}`)
    assert.deepEqual(caret(editor), [lastWord.slice(0, -1), lastWord.slice(-1)])
  })

  test(`in a document ending in ${ending}, a value that arrives after the caret keeps the caret`, async () => {
    const { editor, render } = await mount(`Intro.\n\n${last}`)
    await act(async () => {
      editor.chain().setTextSelection(endOf(editor, 'Intro')).run()
    })
    await render(`Intro.\n\n${lastChanged}`)
    assert.equal(readMarkdown(editor), `Intro.\n\n${lastChanged}`)
    assert.deepEqual(caret(editor), ['Intro', '.'])
  })

  test(`in a document ending in ${ending}, undo reverts the person’s own edit there and keeps what arrived before it`, async () => {
    const { editor, changes, render } = await mount(`Intro.\n\n${last}`)
    await act(async () => {
      editor.chain().setTextSelection(endOf(editor, lastWord)).insertContent('!').run()
    })
    await render(changes[0])
    await render(`Intro, longer.\n\n${last.replace(lastWord, `${lastWord}!`)}`)

    await act(async () => {
      editor.commands.undo()
    })

    assert.equal(readMarkdown(editor), `Intro, longer.\n\n${last}`)
  })
}

test('a key pressed before the editor has read where a click put the caret acts at that caret', async () => {
  const { editor } = await mount('# Scratch\n\nFirst paragraph here.\n\nSecond paragraph.')
  const dom = editor.view.dom
  await act(async () => {
    dom.focus()
  })
  // Where a click leaves the caret: in the page's selection, with the
  // browser's `selectionchange` still queued.
  const second = [...dom.querySelectorAll('p')].find((p) => p.textContent === 'Second paragraph.')
  assert.ok(second?.firstChild)
  document.getSelection()?.collapse(second.firstChild, 'Second paragraph.'.length)
  assert.equal(editor.state.selection.from, 1, 'the editor has not read the new caret yet')

  await act(async () => {
    dom.dispatchEvent(new window.KeyboardEvent('keydown', { key: 'Enter', keyCode: 13, bubbles: true, cancelable: true }))
  })

  const blocks: string[] = []
  editor.state.doc.forEach((node) => blocks.push(`${node.type.name}:${node.textContent}`))
  assert.deepEqual(blocks, ['heading:Scratch', 'paragraph:First paragraph here.', 'paragraph:Second paragraph.', 'paragraph:'])
  assert.equal(editor.state.selection.$from.index(0), 3, 'the caret is in the new paragraph')
})

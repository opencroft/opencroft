// The chat composer's own behaviour, mounted in the command bar under a host:
// what Enter, Shift+Enter and Escape do on a mouse and on a touch screen, how
// the host loads text into it, and what a pasted or dropped picture does.

import assert from 'node:assert/strict'
import { after, afterEach, before, test } from 'node:test'

import { GapCursor } from '@tiptap/pm/gapcursor'

import {
  composerCaret,
  composerEditor,
  composerText,
  installComposerDom,
  pressKey,
  settle,
  testPointer,
  typeText,
} from './test-composer'

let root: import('react-dom/client').Root | null = null
let container: HTMLElement
let act: typeof import('react').act
let useState: typeof import('react').useState
let createRoot: typeof import('react-dom/client').createRoot
let ChatCommandBar: typeof import('./chat-composer').ChatCommandBar
type ChatCommandBarProps = import('./chat-composer').ChatCommandBarProps
type ChatComposerHandle = import('./chat-composer').ChatComposerHandle

before(async () => {
  container = installComposerDom()
  ;({ act, useState } = await import('react'))
  ;({ createRoot } = await import('react-dom/client'))
  ;({ ChatCommandBar } = await import('./chat-composer'))
})

async function unmount() {
  const current = root
  root = null
  if (current) {
    await act(async () => current.unmount())
  }
}

after(unmount)
afterEach(() => {
  testPointer.coarse = false
})

/**
 * The bar under a host that loads text into it with a revision, as the chat's
 * hosts do. `echo` has the host hand every reported value straight back
 * through `value`, with no new revision. Returns what was reported and sent,
 * in order, as `change:<text>` and `send:<text>`.
 */
async function mount(props: Partial<ChatCommandBarProps> = {}, { echo = false } = {}) {
  await unmount()
  const events: string[] = []
  const handle: { current: ChatComposerHandle | null } = { current: null }
  let setState: (update: (state: { value: string; revision: number }) => { value: string; revision: number }) => void =
    () => {}
  function Host() {
    const [state, set] = useState({ value: '', revision: 0 })
    setState = set
    return (
      <ChatCommandBar
        value={state.value}
        valueRevision={state.revision}
        onValueChange={(text) => {
          events.push(`change:${text}`)
          if (echo) {
            set((current) => ({ ...current, value: text }))
          }
        }}
        onSend={(text) => events.push(`send:${text}`)}
        inputRef={handle}
        {...props}
      />
    )
  }
  const next = createRoot(container)
  root = next
  await act(async () => next.render(<Host />))
  await settle()
  return {
    events,
    handle,
    sent: () => events.filter((event) => event.startsWith('send:')).map((event) => event.slice('send:'.length)),
    load: async (text: string) => {
      await act(async () => setState((current) => ({ value: text, revision: current.revision + 1 })))
      await settle()
    },
  }
}

function sendButton(name = 'Send'): HTMLButtonElement {
  const button = container.querySelector<HTMLButtonElement>(`button[aria-label="${name}"]`)
  assert.ok(button, `no ${name} button`)
  return button
}

async function click(button: HTMLButtonElement) {
  await act(async () => {
    button.click()
  })
  await settle()
}

test('Enter sends the message, and the composer reports itself empty before handing it over', async () => {
  const { events } = await mount()
  await typeText(container, 'hello there')
  await pressKey(container, 'Enter')
  assert.deepEqual(events.slice(-2), ['change:', 'send:hello there'])
  assert.equal(composerText(container), '')
})

test('Shift+Enter breaks the line, and the break is sent as a newline', async () => {
  const { sent } = await mount()
  await typeText(container, 'one')
  await pressKey(container, 'Enter', { shiftKey: true })
  await act(async () => {
    composerEditor(container).commands.insertContent('two')
  })
  assert.equal(composerText(container), 'one\ntwo')
  await pressKey(container, 'Enter')
  assert.deepEqual(sent(), ['one\ntwo'])
})

test('on a touch screen Enter breaks the line, and the button sends', async () => {
  testPointer.coarse = true
  const { sent } = await mount()
  await typeText(container, 'one')
  await pressKey(container, 'Enter')
  assert.deepEqual(sent(), [])
  assert.equal(composerText(container), 'one\n')
  await click(sendButton())
  assert.deepEqual(sent(), ['one'])
})

/**
 * The editor's top-level blocks, each as its type and its items' or lines'
 * text, the one holding the caret marked `>`. The editor keeps an empty
 * paragraph last, for the caret to go below a list.
 */
function blocks(): string[] {
  const { doc, selection } = composerEditor(container).state
  const caretBlock = selection.$head.index(0)
  return doc.children.map((block, index) => {
    const parts: string[] = []
    block.forEach((child) => {
      parts.push(child.textContent)
    })
    return `${index === caretBlock ? '>' : ''}${block.type.name}[${parts.join('|')}]`
  })
}

test('in a list Enter starts the next item, Enter on the empty item ends the list, and Enter then sends', async () => {
  const { sent, events } = await mount()
  await typeText(container, '- one')
  await pressKey(container, 'Enter')
  await act(async () => {
    composerEditor(container).commands.insertContent('two')
  })
  await pressKey(container, 'Enter')
  assert.deepEqual(blocks(), ['>bulletList[one|two|]', 'paragraph[]'])
  await pressKey(container, 'Enter')
  assert.deepEqual(blocks(), ['bulletList[one|two]', '>paragraph[]', 'paragraph[]'])
  // The empty lines under the list are not part of the draft.
  assert.equal(events.at(-1), 'change:- one\n- two')
  assert.deepEqual(sent(), [])
  await pressKey(container, 'Enter')
  assert.deepEqual(sent(), ['- one\n- two'])
})

test('in a nested list Enter on the empty item steps out one level', async () => {
  const { sent, load } = await mount()
  await load('- outer\n  - inner')
  assert.deepEqual(blocks(), ['>bulletList[outerinner]', 'paragraph[]'])
  await pressKey(container, 'Enter')
  await pressKey(container, 'Enter')
  assert.deepEqual(blocks(), ['>bulletList[outerinner|]', 'paragraph[]'])
  assert.deepEqual(sent(), [])
})

test('in a quote Enter starts a paragraph of the quote, and Enter on the empty one steps out of it', async () => {
  const { sent } = await mount()
  await typeText(container, '> quoted')
  await pressKey(container, 'Enter')
  assert.deepEqual(blocks(), ['>blockquote[quoted|]', 'paragraph[]'])
  await pressKey(container, 'Enter')
  assert.deepEqual(blocks(), ['blockquote[quoted]', '>paragraph[]', 'paragraph[]'])
  assert.deepEqual(sent(), [])
  await pressKey(container, 'Enter')
  assert.deepEqual(sent(), ['> quoted'])
})

test('in a code block Enter starts a line of the code, and the third at its end steps out of it', async () => {
  const { sent, load } = await mount()
  await load('```\ncode\n```')
  await pressKey(container, 'Enter')
  assert.deepEqual(blocks(), ['>codeBlock[code\n]', 'paragraph[]'])
  await pressKey(container, 'Enter')
  await pressKey(container, 'Enter')
  assert.equal(blocks()[0], 'codeBlock[code]')
  assert.ok(blocks().slice(1).includes('>paragraph[]'), `caret not below the code: ${blocks()}`)
  assert.deepEqual(sent(), [])
  await pressKey(container, 'Enter')
  assert.deepEqual(sent(), ['```\ncode\n```'])
})

test('in a heading Enter starts a paragraph below it, and Enter there sends', async () => {
  const { sent } = await mount()
  await typeText(container, '# Title')
  assert.deepEqual(blocks(), ['>heading[Title]', 'paragraph[]'])
  await pressKey(container, 'Enter')
  assert.deepEqual(blocks(), ['heading[Title]', '>paragraph[]', 'paragraph[]'])
  assert.deepEqual(sent(), [])
  await act(async () => {
    composerEditor(container).commands.insertContent('body')
  })
  await pressKey(container, 'Enter')
  assert.deepEqual(sent(), ['# Title\n\nbody'])
})

test('with all of plain lines selected Enter sends them', async () => {
  const { sent, load } = await mount()
  await load('one\n\ntwo')
  await act(async () => {
    composerEditor(container).commands.selectAll()
  })
  await pressKey(container, 'Enter')
  assert.deepEqual(sent(), ['one\n\ntwo'])
})

test("with a list among the selected lines Enter is the editor's and sends nothing", async () => {
  const { sent, load } = await mount()
  await load('- one\n\ntwo')
  await act(async () => {
    composerEditor(container).commands.selectAll()
  })
  await pressKey(container, 'Enter')
  assert.deepEqual(sent(), [])
})

test("at the gap cursor above a table Enter is the editor's and sends nothing", async () => {
  const { sent } = await mount()
  await act(async () => {
    const editor = composerEditor(container)
    editor.commands.insertTable({ rows: 2, cols: 1, withHeaderRow: true })
    const { state, view } = editor
    view.dispatch(state.tr.setSelection(new GapCursor(state.doc.resolve(0))))
  })
  assert.equal(blocks()[0], '>table[|]')
  await pressKey(container, 'Enter')
  assert.deepEqual(sent(), [])
  assert.deepEqual(blocks().slice(0, 2), ['>paragraph[]', 'table[|]'])
})

test('on a touch screen Enter in a list starts the next item rather than breaking the line', async () => {
  testPointer.coarse = true
  const { sent } = await mount()
  await typeText(container, '- one')
  await pressKey(container, 'Enter')
  assert.deepEqual(blocks(), ['>bulletList[one|]', 'paragraph[]'])
  assert.deepEqual(sent(), [])
})

test('Enter on an empty composer sends nothing, even where the button may send it empty', async () => {
  const { sent } = await mount({ emptySendLabel: 'Start without a message' })
  await pressKey(container, 'Enter')
  assert.deepEqual(sent(), [])
  await click(sendButton('Start without a message'))
  assert.deepEqual(sent(), [''])
})

test('while a send is in flight Enter sends nothing and the text stays', async () => {
  const { sent } = await mount({ sending: true })
  await typeText(container, 'wait')
  await pressKey(container, 'Enter')
  assert.deepEqual(sent(), [])
  assert.equal(composerText(container), 'wait')
})

test("Escape clears the text, or is the host's when it takes it", async () => {
  const { events } = await mount()
  await typeText(container, 'abandon')
  await pressKey(container, 'Escape')
  assert.equal(composerText(container), '')
  assert.equal(events.at(-1), 'change:')

  let escaped = 0
  await mount({ onEscape: () => escaped++ })
  await typeText(container, 'kept')
  await pressKey(container, 'Escape')
  assert.equal(escaped, 1)
  assert.equal(composerText(container), 'kept')
})

test('with the selection bar open Escape closes the bar and keeps the text; the next one clears it', async () => {
  await mount()
  await typeText(container, 'keep this')
  const editor = composerEditor(container)
  await act(async () => {
    editor.commands.setTextSelection({ from: 6, to: 10 })
  })
  await settle()
  assert.ok(editor.isFocused, 'the text has focus')
  assert.ok(document.querySelector('[aria-label="Selection"]'), 'the bar is open')
  await pressKey(container, 'Escape')
  assert.equal(document.querySelector('[aria-label="Selection"]'), null, 'the bar closes')
  assert.equal(composerText(container), 'keep this')
  await pressKey(container, 'Escape')
  assert.equal(composerText(container), '')
})

test('a load with a new revision replaces the text, caret at its end; the same text loads again on the next one', async () => {
  const { load } = await mount()
  await typeText(container, 'typed')
  await load('saved text')
  assert.equal(composerText(container), 'saved text')
  assert.equal(composerCaret(container), 'saved text'.length)
  await typeText(container, 'typed over it')
  await load('saved text')
  assert.equal(composerText(container), 'saved text')
})

test('an echo of what was typed loads nothing, so the caret stays where it was', async () => {
  await mount({}, { echo: true })
  await typeText(container, 'hello world', 5)
  assert.equal(composerCaret(container), 5)
  assert.equal(composerText(container), 'hello world')
})

test('a stored message loads with its line breaks', async () => {
  const { load } = await mount()
  await load('first line\nsecond line')
  assert.equal(composerText(container), 'first line\nsecond line')
})

test('focusEnd puts focus in the text with the caret at its end', async () => {
  const { handle, load } = await mount()
  await load('ready to revise')
  await act(async () => {
    composerEditor(container).commands.setTextSelection(3)
    handle.current?.focusEnd()
  })
  await settle()
  assert.equal(composerCaret(container), 'ready to revise'.length)
})

test('an Enter that ends an input method composition does not send', async () => {
  const { sent } = await mount()
  await typeText(container, 'kanji')
  const dom = composerEditor(container).view.dom
  await act(async () => {
    dom.dispatchEvent(new window.CompositionEvent('compositionstart', { bubbles: true }))
  })
  await pressKey(container, 'Enter', { isComposing: true })
  assert.deepEqual(sent(), [])
  await act(async () => {
    dom.dispatchEvent(new window.CompositionEvent('compositionend', { bubbles: true }))
    // ProseMirror ends the composition a moment after its event, and in
    // Safari (which jsdom's navigator says it is) also leaves the keydown that
    // follows within half a second to the input method.
    await new Promise((resolve) => setTimeout(resolve, 600))
  })
  assert.equal(composerEditor(container).view.composing, false)
  assert.equal(composerText(container), 'kanji')
  // Once the composition is over, Enter sends.
  await pressKey(container, 'Enter')
  assert.deepEqual(sent(), ['kanji'])
})

/** A clipboard or a drag carrying `files`, `text` as plain text and `html`. */
function transfer(files: File[], text = '', html = '') {
  return {
    items: files.map((file) => ({ kind: 'file', type: file.type, getAsFile: () => file })),
    types: [...(files.length > 0 ? ['Files'] : []), ...(text ? ['text/plain'] : []), ...(html ? ['text/html'] : [])],
    files,
    getData: (type: string) => (type === 'text/plain' ? text : type === 'text/html' ? html : ''),
  }
}

function picture(): File {
  return new window.File(['picture'], 'screenshot.png', { type: 'image/png' })
}

/** Pastes `data` into the composer, as the browser does on Ctrl+V. */
async function paste(data: ReturnType<typeof transfer>) {
  await act(async () => {
    const event = new window.Event('paste', { bubbles: true, cancelable: true })
    Object.defineProperty(event, 'clipboardData', { value: data })
    composerEditor(container).view.dom.dispatchEvent(event)
  })
}

test('a pasted picture is handed over as a file, and pasted text goes into the message', async () => {
  const received: File[][] = []
  await mount({ onFiles: (files) => received.push(files) })
  await typeText(container, '')
  await paste(transfer([picture()]))
  assert.deepEqual(
    received.map((files) => files.map((file) => file.name)),
    [['screenshot.png']],
  )
  assert.equal(composerText(container), '')
  await paste(transfer([], 'pasted words'))
  assert.equal(received.length, 1)
  assert.equal(composerText(container), 'pasted words')
})

test('pasted lines are sent as lines, indented as they were pasted', async () => {
  const { sent } = await mount()
  await typeText(container, '')
  await paste(transfer([], 'Traceback:\n  File "app.py", line 3\nValueError: no'))
  assert.equal(composerText(container), 'Traceback:\n  File "app.py", line 3\nValueError: no')
  await pressKey(container, 'Enter')
  assert.deepEqual(sent(), ['Traceback:\n  File "app.py", line 3\nValueError: no'])
})

test('pasted markdown arrives formatted, and Shift-paste puts the text in as typed', async () => {
  const { sent } = await mount()
  await typeText(container, '')
  await paste(transfer([], 'a **bold** word'))
  assert.equal(composerText(container), 'a bold word')
  await pressKey(container, 'Enter')

  await pressKey(container, 'Shift', { shiftKey: true })
  await paste(transfer([], 'see __init__.py\r\nnext line'))
  assert.equal(composerText(container), 'see __init__.py\nnext line')
  await pressKey(container, 'Enter')
  assert.deepEqual(sent(), ['a **bold** word', 'see \\_\\_init\\_\\_.py\nnext line'])
})

// Code as a code editor copies it: each line a block, laid out as preformatted.
const CODE = 'def area(r):\n    return r + r\n\nprint(area(2))'
const CODE_HTML =
  '<meta charset="utf-8"><div style="font-family: monospace; white-space: pre;">' +
  '<div><span>def area(r):</span></div><div><span>    return r + r</span></div><br>' +
  '<div><span>print(area(2))</span></div></div>'

test("a code editor's copy is sent as its lines, and Shift-pasted as typed", async () => {
  const { sent } = await mount()
  await typeText(container, '')
  await paste(transfer([], CODE, CODE_HTML))
  await pressKey(container, 'Enter')
  await pressKey(container, 'Shift', { shiftKey: true })
  await paste(
    transfer([], 'from pkg import __init__', '<div style="white-space: pre;"><div>from pkg import __init__</div></div>'),
  )
  await pressKey(container, 'Enter')
  assert.deepEqual(sent(), [CODE, 'from pkg import \\_\\_init\\_\\_'])
})

test('pasted HTML that carries formatting is read as HTML', async () => {
  const { sent } = await mount()
  await typeText(container, '')
  await paste(transfer([], 'a bold word', '<p>a <strong>bold</strong> word</p>'))
  await pressKey(container, 'Enter')
  assert.deepEqual(sent(), ['a **bold** word'])
})

test('a picture dropped on the composer is handed over once', async () => {
  const received: File[][] = []
  await mount({ onFiles: (files) => received.push(files) })
  const dom = composerEditor(container).view.dom
  await act(async () => {
    const event = new window.Event('drop', { bubbles: true, cancelable: true })
    Object.defineProperty(event, 'dataTransfer', { value: transfer([picture()]) })
    dom.dispatchEvent(event)
  })
  assert.equal(received.length, 1)
})

// A clipboard holding only a picture gives the paste no text; the editor leaves
// such a paste to the browser, which writes the picture in as a `data:` image.
// The event left unprevented is that hand-off.
test('without a host that takes pictures, a pasted or dropped picture is refused and nothing goes into the text', async () => {
  const { sent } = await mount()
  await typeText(container, 'pic: ')
  const dom = composerEditor(container).view.dom
  const pasted = [transfer([picture()]), transfer([picture()], '', '<img src="data:image/png;base64,cGljdHVyZQ==">')]
  for (const data of pasted) {
    const event = new window.Event('paste', { bubbles: true, cancelable: true })
    Object.defineProperty(event, 'clipboardData', { value: data })
    await act(async () => {
      dom.dispatchEvent(event)
    })
    assert.equal(event.defaultPrevented, true)
  }
  // ProseMirror takes a drop only at a point in the text, which a DOM without
  // layout can't find: the point is given.
  const { view } = composerEditor(container)
  const drop = new window.Event('drop', { bubbles: true, cancelable: true })
  Object.defineProperty(drop, 'dataTransfer', { value: transfer([picture()]) })
  view.posAtCoords = () => ({ pos: 1, inside: -1 })
  await act(async () => {
    dom.dispatchEvent(drop)
  })
  assert.equal(drop.defaultPrevented, true)
  assert.equal(dom.querySelectorAll('img').length, 0)
  await pressKey(container, 'Enter')
  assert.deepEqual(sent(), ['pic:'])
})

// As an office app copies cells or text: the text, HTML for it, and a picture of the copy.
const OFFICE_HTML = '<table><tr><td>from the html</td></tr></table><img src="data:image/png;base64,cGljdHVyZQ==">'

test("without a host that takes pictures, a paste's plain text goes in beside the refused picture, its HTML left out", async () => {
  const { sent } = await mount()
  await typeText(container, '')
  await paste(transfer([picture()], 'a **bold** word', OFFICE_HTML))
  assert.equal(composerText(container), 'a bold word')
  assert.equal(composerEditor(container).view.dom.querySelectorAll('img').length, 0)
  await pressKey(container, 'Enter')

  await pressKey(container, 'Shift', { shiftKey: true })
  await paste(transfer([picture()], 'a **bold** word', OFFICE_HTML))
  await pressKey(container, 'Enter')
  assert.deepEqual(sent(), ['a **bold** word', 'a \\*\\*bold\\*\\* word'])
})

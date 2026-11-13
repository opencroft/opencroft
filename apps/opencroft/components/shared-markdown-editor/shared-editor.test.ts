// The editor of a shared document, against a Yjs document in memory: whose
// changes undo reverts, how many steps one undo takes, and how a change made
// from outside an editor is played back. A change from elsewhere is applied to
// the same Yjs document under an origin of its own, which is how a synced
// update arrives.
import assert from 'node:assert/strict'
import { after, test } from 'node:test'

import { installDomEnvironment } from '@/test-support/dom-environment'

const dom = await installDomEnvironment()
// The playback asks whether motion is reduced; jsdom has no media queries.
;(globalThis.window as unknown as { matchMedia: unknown }).matchMedia = () => ({ matches: false })
// An editor's `focus()` waits a frame before it scrolls the caret into view.
globalThis.requestAnimationFrame = window.requestAnimationFrame
globalThis.cancelAnimationFrame = window.cancelAnimationFrame

const { Editor } = await import('@tiptap/core')
const { Collaboration } = await import('@tiptap/extension-collaboration')
const {
  absolutePositionToRelativePosition,
  initProseMirrorDoc,
  prosemirrorJSONToYXmlFragment,
  updateYFragment,
  yUndoPluginKey,
  yXmlFragmentToProsemirrorJSON,
} = await import('@tiptap/y-tiptap')
const { markdownEditorExtensions, readMarkdown } = await import('agent-chat/components/markdown-editor')
const { markdownConverter, markdownSchema } = await import('agent-chat/markdown-schema')
const Y = await import('yjs')
const { EditPlayback } = await import('@/components/shared-markdown-editor/edit-playback')
const { OneStepUndo } = await import('@/components/shared-markdown-editor/one-step-undo')
const { MARKDOWN_DOC_FIELD } = await import('@/lib/markdown-doc-protocol')
const { changedRange } = await import('agent-chat/markdown-doc-change')
const { applyLink, editLink } = await import('agent-chat/components/markdown-editor-link')
const { applyHint, editHint, hintTarget, removeHint } = await import('agent-chat/components/markdown-editor-hint')
type MarkdownEditMessage = import('@/lib/markdown-doc-protocol').MarkdownEditMessage

after(() => dom.cleanup())

const ELSEWHERE = 'elsewhere'

/** A Yjs document holding `markdown`, as a synced copy holds it. */
function sharedDoc(markdown: string) {
  const doc = new Y.Doc()
  prosemirrorJSONToYXmlFragment(
    markdownSchema(),
    markdownConverter().parse(markdown),
    doc.getXmlFragment(MARKDOWN_DOC_FIELD),
  )
  return doc
}

/** An editor bound to `doc` the way a shared document's editor is. */
function editorOn(doc: InstanceType<typeof Y.Doc>, extra: ReturnType<typeof EditPlayback.configure>[] = []) {
  return new Editor({
    element: document.createElement('div'),
    extensions: markdownEditorExtensions({
      collaboration: [Collaboration.configure({ document: doc, field: MARKDOWN_DOC_FIELD }), OneStepUndo, ...extra],
    }),
  })
}

/** The text of the `index`-th top-level block, as the Yjs document holds it. */
function blockText(doc: InstanceType<typeof Y.Doc>, index: number): InstanceType<typeof Y.XmlText> {
  const block = doc.getXmlFragment(MARKDOWN_DOC_FIELD).get(index) as InstanceType<typeof Y.XmlElement>
  return block.get(0) as InstanceType<typeof Y.XmlText>
}

/** Types `text` at the end of the `index`-th top-level block, as a person would in this editor. */
function typeAtEnd(editor: InstanceType<typeof Editor>, index: number, text: string) {
  let end = 0
  editor.state.doc.forEach((node, offset, i) => {
    if (i === index) {
      end = offset + node.nodeSize - 1
    }
  })
  editor.view.dispatch(editor.state.tr.insertText(text, end))
}

function stopCapturing(editor: InstanceType<typeof Editor>) {
  ;(yUndoPluginKey.getState(editor.state) as { undoManager: { stopCapturing(): void } }).undoManager.stopCapturing()
}

test('undo reverts this editor’s own change, never one made elsewhere', () => {
  const doc = sharedDoc('Mine\n\nTheirs')
  const editor = editorOn(doc)
  typeAtEnd(editor, 0, ' typed here')
  doc.transact(() => blockText(doc, 1).insert(6, ' typed there'), ELSEWHERE)
  assert.equal(readMarkdown(editor), 'Mine typed here\n\nTheirs typed there')
  assert.ok(editor.commands.undo())
  assert.equal(readMarkdown(editor), 'Mine\n\nTheirs typed there')
  assert.equal(editor.commands.undo(), false)
  editor.destroy()
})

test('one undo reverts one step, even when others have overwritten the latest one', () => {
  const doc = sharedDoc('First\n\nSecond')
  const editor = editorOn(doc)
  typeAtEnd(editor, 0, ' one')
  stopCapturing(editor)
  typeAtEnd(editor, 1, ' two')
  // Someone else deletes everything the latest step typed.
  doc.transact(() => {
    const text = blockText(doc, 1)
    text.delete(0, text.length)
  }, ELSEWHERE)
  editor.commands.undo()
  assert.equal(readMarkdown(editor), 'First one', 'the older step is still there')
  editor.commands.undo()
  assert.equal(readMarkdown(editor), 'First')
  editor.destroy()
})

test('formatting is a step of its own, even within a second of typing', () => {
  const doc = sharedDoc('Plain')
  const editor = editorOn(doc)
  typeAtEnd(editor, 0, ' words')
  // Straight after, well inside the merge window: bold the typed words.
  editor.chain().setTextSelection({ from: 7, to: 12 }).setBold().run()
  assert.equal(readMarkdown(editor), 'Plain **words**')
  editor.commands.undo()
  assert.equal(readMarkdown(editor), 'Plain words', 'the first Ctrl+Z takes the bold only')
  editor.commands.undo()
  assert.equal(readMarkdown(editor), 'Plain')
  editor.destroy()
})

test('typing after the caret moved elsewhere is a step of its own', () => {
  const doc = sharedDoc('First\n\nSecond')
  const editor = editorOn(doc)
  typeAtEnd(editor, 0, ' one')
  editor.commands.setTextSelection(2)
  typeAtEnd(editor, 1, ' two')
  editor.commands.undo()
  assert.equal(readMarkdown(editor), 'First one\n\nSecond')
  editor.commands.undo()
  assert.equal(readMarkdown(editor), 'First\n\nSecond')
  editor.destroy()
})

const AGENT = { kind: 'agent', name: 'agent-a' } as const

/** An editor of `markdown` that plays back changes, and a way to hand it an announcement. */
function playingEditor(markdown: string) {
  const doc = sharedDoc(markdown)
  let deliver: (event: { payload: string }) => void = () => {}
  const provider = {
    on: (_event: string, listener: typeof deliver) => {
      deliver = listener
    },
    off: () => {},
  }
  const playing: string[][] = []
  const editor = editorOn(doc, [
    EditPlayback.configure({
      provider: provider as never,
      onPlaying: (origins) => playing.push(origins.map((origin) => origin.name)),
    }),
  ])
  const announce = (message: MarkdownEditMessage) => deliver({ payload: JSON.stringify(message) })
  return { doc, editor, playing, announce }
}

/**
 * Changes `doc` to `markdown` from elsewhere, as the server does, and returns
 * the announcement the server makes of it.
 */
function changeElsewhere(doc: InstanceType<typeof Y.Doc>, markdown: string): MarkdownEditMessage {
  const fragment = doc.getXmlFragment(MARKDOWN_DOC_FIELD)
  const before = initProseMirrorDoc(fragment, markdownSchema()).doc
  const next = markdownSchema().nodeFromJSON(markdownConverter().parse(markdown))
  doc.transact(() => updateYFragment(doc, fragment, next, { mapping: new Map(), isOMark: new Map() }), ELSEWHERE)
  const { doc: after, mapping } = initProseMirrorDoc(fragment, markdownSchema())
  const range = changedRange(before, after)
  assert.ok(range, 'the change changed something')
  const at = (pos: number) => Y.relativePositionToJSON(absolutePositionToRelativePosition(pos, fragment, mapping))
  return { type: 'markdown-edit', origin: AGENT, from: at(range.from), to: at(range.endAfter) }
}

/** What is being swept: the replaced content as drawn. */
function swept(editor: InstanceType<typeof Editor>): HTMLElement {
  const old = editor.view.dom.querySelector<HTMLElement>('[style*="agent-edit-sweep"], [style="display: contents"]')
  assert.ok(old, 'something is being swept')
  return old
}

test('a replacement that adds a paragraph shows no empty line while the old text is swept', () => {
  const { doc, editor, announce } = playingEditor('Say hello to everyone')
  announce(changeElsewhere(doc, 'Say goodbye\n\nAnd see you soon'))

  assert.equal(readMarkdown(editor), 'Say goodbye\n\nAnd see you soon', 'the document holds the whole change')
  // The change reaches across blocks, so the replaced paragraph is swept whole
  // where the two new ones will stand, and they take no space meanwhile.
  assert.deepEqual(
    [...swept(editor).children].map((block) => [block.tagName, block.textContent]),
    [['P', 'Say hello to everyone']],
  )
  const blocks = [...editor.view.dom.children].filter((block) => !block.classList.contains('ProseMirror-widget'))
  assert.equal(blocks.length, 2)
  for (const block of blocks) {
    assert.match(block.getAttribute('style') ?? '', /display: none/, `"${block.textContent}" takes no space`)
  }
  editor.destroy()
})

test('replaced content is swept as the editor drew it, not as its markdown', () => {
  const { doc, editor, announce } = playingEditor('Say **hello** to [everyone](https://example.com)')
  announce(changeElsewhere(doc, 'Say goodbye to you'))

  const old = swept(editor)
  assert.equal(old.textContent, 'hello to everyone')
  assert.equal(old.querySelector('strong')?.textContent, 'hello', 'bold stays bold')
  assert.equal(old.querySelector('a')?.textContent, 'everyone', 'a link stays a link')
  assert.doesNotMatch(old.textContent ?? '', /\*|\[|\]\(/, 'no markdown')
  editor.destroy()
})

test('replaced blocks are swept as the blocks they were: a list as a list', () => {
  const { doc, editor, announce } = playingEditor('Intro\n\n- one\n- two\n\nOutro')
  announce(changeElsewhere(doc, 'Intro\n\nOne and two.\n\nOutro'))

  const old = swept(editor)
  assert.deepEqual(
    [...old.querySelectorAll('ul > li')].map((item) => item.textContent),
    ['one', 'two'],
  )
  assert.doesNotMatch(old.textContent ?? '', /-/, 'no list markers as text')
  // Its label stands before the swept list, taking no line of its own.
  const label = old.previousElementSibling
  assert.match(label?.textContent ?? '', /agent-a/)
  editor.destroy()
})

test('another change from elsewhere, outside the range being played, leaves the playback on its text', () => {
  const { doc, editor, playing, announce } = playingEditor('First\n\nSay hello to everyone\n\nLast')
  announce(changeElsewhere(doc, 'First\n\nSay goodbye to everyone\n\nLast'))
  const waiting = () =>
    [...editor.view.dom.querySelectorAll<HTMLElement>('[style*="display: none"]')]
      .map((element) => element.textContent)
      .join('')
  const stillPlaying = (when: string) => {
    assert.deepEqual(playing.at(-1), ['agent-a'], `still playing ${when}`)
    assert.equal(swept(editor).textContent, 'hello', `the replaced text is swept ${when}`)
    assert.equal(waiting(), 'goodbye', `the new text is what waits ${when}`)
  }
  stillPlaying('at first')

  // Someone else types ahead of the range, which moves it, and then after it.
  doc.transact(() => blockText(doc, 0).insert(0, 'The very '), ELSEWHERE)
  assert.equal(readMarkdown(editor), 'The very First\n\nSay goodbye to everyone\n\nLast')
  stillPlaying('after a change ahead of it')
  doc.transact(() => blockText(doc, 2).insert(4, ' words'), ELSEWHERE)
  assert.equal(readMarkdown(editor), 'The very First\n\nSay goodbye to everyone\n\nLast words')
  stillPlaying('after a change behind it')
  editor.destroy()
})

test('a change made elsewhere is in the document at once, and played back over it', async () => {
  const { doc, editor, playing, announce } = playingEditor('Say hello to everyone')

  // The change and its announcement, as the server makes them -- on a copy of
  // its own -- and sends them: the announcement can arrive first, as it does
  // over a real socket, before this copy holds the positions it names.
  const server = new Y.Doc()
  Y.applyUpdate(server, Y.encodeStateAsUpdate(doc))
  const before = Y.encodeStateVector(server)
  announce(changeElsewhere(server, 'Say goodbye to everyone'))
  assert.equal(readMarkdown(editor), 'Say hello to everyone', 'the change itself has not arrived yet')
  Y.applyUpdate(doc, Y.encodeStateAsUpdate(server, before), ELSEWHERE)
  await Promise.resolve()

  assert.equal(readMarkdown(editor), 'Say goodbye to everyone', 'the document holds the whole change')
  const shown = editor.view.dom
  const waiting = () =>
    [...shown.querySelectorAll<HTMLElement>('[style*="display: none"]')].map((element) => element.textContent).join('')
  assert.match(shown.textContent ?? '', /agent-a/, 'the agent’s name is shown')
  assert.match(shown.textContent ?? '', /hello/, 'the replaced text shows while it is swept')
  assert.equal(waiting(), 'goodbye', 'the new text takes no space until the sweep is done')
  assert.deepEqual(playing.at(-1), ['agent-a'])

  // Typing into the range ends the playback there and then.
  editor.view.dispatch(editor.state.tr.insertText('!', 8))
  assert.equal(waiting(), '')
  assert.doesNotMatch(shown.textContent ?? '', /agent-a/)
  assert.deepEqual(playing.at(-1), [])
  editor.destroy()
})

/** Opens the link popover on the first `text` in the editor's document. */
function pickForLink(editor: InstanceType<typeof Editor>, text: string) {
  let from = -1
  editor.state.doc.descendants((node, pos) => {
    const at = node.isText ? (node.text ?? '').indexOf(text) : -1
    if (from < 0 && at >= 0) {
      from = pos + at
    }
  })
  assert.ok(from >= 0, `"${text}" is in the document`)
  editor.commands.setTextSelection({ from, to: from + text.length })
  assert.ok(editLink(editor))
}

/** The text the link popover is editing, as it is painted. */
function picked(editor: InstanceType<typeof Editor>): string {
  return [...editor.view.dom.querySelectorAll('.markdown-editor-inline-target')]
    .map((part) => part.textContent)
    .join('')
}

test('a link goes on the text picked for it after a change from elsewhere before it', () => {
  const doc = sharedDoc('Intro\n\nA word to link here')
  const editor = editorOn(doc)
  pickForLink(editor, 'word')
  doc.transact(() => blockText(doc, 0).insert(0, 'New '), ELSEWHERE)
  assert.equal(picked(editor), 'word')
  assert.ok(applyLink(editor, 'word', 'https://example.com'))
  assert.equal(readMarkdown(editor), 'New Intro\n\nA [word](https://example.com) to link here')
  editor.destroy()
})

/** The markdown the Yjs document holds, as the server writes it to storage. */
function storedMarkdown(doc: InstanceType<typeof Y.Doc>): string {
  return markdownConverter().serialize(yXmlFragmentToProsemirrorJSON(doc.getXmlFragment(MARKDOWN_DOC_FIELD)))
}

/** The position of the `index`-th icon in the editor's document. */
function iconAt(editor: InstanceType<typeof Editor>, index: number): number {
  const found: number[] = []
  editor.state.doc.descendants((node, pos) => {
    if (node.type.name === 'markdownIcon') {
      found.push(pos)
    }
  })
  assert.ok(index < found.length, `the document has icon ${index}`)
  return found[index]
}

test('hints over icons hold in the shared document, read, added and removed', () => {
  const hinted = 'Ship :hint[**today** :icon[rocket] 🚀]{text="Soon"} now'
  const doc = sharedDoc(`${hinted}\n\nJust :icon[star] here`)
  const editor = editorOn(doc)
  assert.equal(readMarkdown(editor), `${hinted}\n\nJust :icon[star] here`)
  // A caret beside the hinted icon is in the whole hint.
  editor.commands.setTextSelection(iconAt(editor, 0))
  assert.equal(hintTarget(editor.state)?.values.text, 'Soon')
  assert.equal(hintTarget(editor.state)?.existing, true)

  editor.commands.setTextSelection({ from: iconAt(editor, 1), to: iconAt(editor, 1) + 1 })
  assert.ok(editHint(editor))
  assert.ok(applyHint(editor, 'Star'))
  assert.equal(storedMarkdown(doc), `${hinted}\n\nJust :hint[:icon[star]]{text="Star"} here`)

  editor.commands.setTextSelection(iconAt(editor, 0))
  assert.ok(editHint(editor))
  assert.ok(removeHint(editor))
  assert.equal(storedMarkdown(doc), 'Ship **today** :icon[rocket] 🚀 now\n\nJust :hint[:icon[star]]{text="Star"} here')
  editor.destroy()
})

test('a link takes in what a change from elsewhere wrote inside the picked text', () => {
  const doc = sharedDoc('A word to link here')
  const editor = editorOn(doc)
  pickForLink(editor, 'word to link')
  doc.transact(() => blockText(doc, 0).insert('A word'.length, 'ing'), ELSEWHERE)
  assert.equal(picked(editor), 'wording to link')
  // The text field still holds what the popover opened with.
  assert.ok(applyLink(editor, 'word to link', 'https://example.com'))
  assert.equal(readMarkdown(editor), 'A [wording to link](https://example.com) here')
  editor.destroy()
})

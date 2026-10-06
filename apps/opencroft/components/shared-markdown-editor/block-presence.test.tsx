// Two mounted editors of one shared document, each on its own Yjs copy, with
// updates and awareness relayed between them as the provider relays them:
// which block one editor's tag marks in the other while its focus is in that
// block's own controls. Mounted rather than headless, because the controls
// are what the block views draw.
import assert from 'node:assert/strict'
import { after, afterEach, test } from 'node:test'

import { installDomEnvironment } from '@/test-support/dom-environment'

const dom = await installDomEnvironment()

const { act } = await import('react')
const { createRoot } = await import('react-dom/client')
const { Collaboration } = await import('@tiptap/extension-collaboration')
const { prosemirrorJSONToYXmlFragment } = await import('@tiptap/y-tiptap')
const { MarkdownEditor } = await import('agent-chat/markdown-editor')
const { markdownConverter, markdownSchema } = await import('agent-chat/markdown-schema')
const Y = await import('yjs')
const { Awareness, applyAwarenessUpdate, encodeAwarenessUpdate } = await import('y-protocols/awareness')
const { BlockPresence } = await import('@/components/shared-markdown-editor/block-presence')
const { MARKDOWN_DOC_FIELD } = await import('@/lib/markdown-doc-protocol')

type Root = import('react-dom/client').Root

after(() => dom.cleanup())

let teardown: (() => Promise<void>)[] = []
afterEach(async () => {
  for (const step of teardown.reverse()) {
    await step()
  }
  teardown = []
})

/** A tag that says whose it is and which anchor it is tethered to. */
function renderTag(user: unknown, anchor: string): HTMLElement | null {
  const name = (user as { name?: unknown } | undefined)?.name
  if (typeof name !== 'string') {
    return null
  }
  const tag = document.createElement('span')
  tag.dataset.presence = name
  tag.dataset.anchor = anchor
  return tag
}

/** Every change and awareness update of `from` applied to `to`, as the provider would deliver it. */
function relay(from: InstanceType<typeof Y.Doc>, to: InstanceType<typeof Y.Doc>) {
  from.on('update', (update: Uint8Array, origin: unknown) => {
    if (origin !== 'relay') {
      Y.applyUpdate(to, update, 'relay')
    }
  })
}

function relayAwareness(from: InstanceType<typeof Awareness>, to: InstanceType<typeof Awareness>) {
  from.on('update', ({ added, updated, removed }: { added: number[]; updated: number[]; removed: number[] }) => {
    applyAwarenessUpdate(to, encodeAwarenessUpdate(from, [...added, ...updated, ...removed]), 'relay')
  })
}

interface Mounted {
  container: HTMLElement
  awareness: InstanceType<typeof Awareness>
  unmount: () => Promise<void>
}

/** An editor of `doc`, mounted, announcing itself as `name`. */
async function mountEditor(doc: InstanceType<typeof Y.Doc>, name: string): Promise<Mounted> {
  const awareness = new Awareness(doc)
  awareness.setLocalStateField('user', { name })
  const container = document.createElement('div')
  document.body.append(container)
  const root: Root = createRoot(container)
  await act(async () => {
    root.render(
      <MarkdownEditor
        collaboration={[
          Collaboration.configure({ document: doc, field: MARKDOWN_DOC_FIELD }),
          BlockPresence.configure({ awareness, render: renderTag }),
        ]}
      />,
    )
  })
  // The editor is created after the first render, and its node views after that.
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 0))
  })
  let mounted = true
  const unmount = async () => {
    if (mounted) {
      mounted = false
      await act(async () => root.unmount())
      container.remove()
      awareness.destroy()
    }
  }
  teardown.push(unmount)
  return { container, awareness, unmount }
}

/** Two editors of one document holding `markdown`: alice's and bob's. */
async function twoEditors(markdown: string) {
  const aliceDoc = new Y.Doc()
  const bobDoc = new Y.Doc()
  relay(aliceDoc, bobDoc)
  relay(bobDoc, aliceDoc)
  prosemirrorJSONToYXmlFragment(
    markdownSchema(),
    markdownConverter().parse(markdown),
    aliceDoc.getXmlFragment(MARKDOWN_DOC_FIELD),
  )
  const alice = await mountEditor(aliceDoc, 'alice')
  const bob = await mountEditor(bobDoc, 'bob')
  relayAwareness(alice.awareness, bob.awareness)
  relayAwareness(bob.awareness, alice.awareness)
  return { alice, bob }
}

function input(editor: Mounted, label: string): HTMLInputElement {
  const found = editor.container.querySelector<HTMLInputElement>(`input[aria-label="${label}"]`)
  assert.ok(found, `the editor draws the ${label} input`)
  return found
}

async function focus(element: HTMLElement) {
  await act(async () => element.focus())
}

function proseMirror(editor: Mounted): HTMLElement {
  const found = editor.container.querySelector<HTMLElement>('.ProseMirror')
  assert.ok(found, 'the editor is mounted')
  return found
}

/** The blocks in `editor` taking `anchor` as one of their anchor names. */
function anchored(editor: Mounted, anchor: string): HTMLElement[] {
  return [...proseMirror(editor).querySelectorAll<HTMLElement>('[style]')].filter((element) =>
    element.style
      .getPropertyValue('anchor-name')
      .split(',')
      .some((name) => name.trim() === anchor),
  )
}

/** The tags drawn in `editor`, each with the text of the one block it is tethered to. */
function tags(editor: Mounted): { name: string | undefined; on: string[] }[] {
  return [...editor.container.querySelectorAll<HTMLElement>('[data-presence]')].map((tag) => ({
    name: tag.dataset.presence,
    // The block's text, not its controls' labels.
    on: anchored(editor, tag.dataset.anchor ?? '').map(
      (block) => block.querySelector('[data-node-view-content-react]')?.textContent ?? '',
    ),
  }))
}

/** The elements the editor's document is drawn as, in order. */
function blockOutline(editor: Mounted): string[] {
  return [...proseMirror(editor).querySelectorAll('*')].map((element) => element.tagName)
}

test('a collaborator in a callout’s title is tagged on that callout', async () => {
  const { alice, bob } = await twoEditors('Intro.\n\n:::note\nInside the note.\n:::\n\nOutro.')
  await focus(input(alice, 'Callout title'))
  assert.deepEqual(tags(bob), [{ name: 'alice', on: ['Inside the note.'] }])
  assert.deepEqual(tags(alice), [], 'an editor does not tag itself')
})

test('a tag puts nothing among the blocks: it is kept outside the document', async () => {
  const { alice, bob } = await twoEditors(':::note\nFirst block.\n:::\n\nA paragraph.\n\n:::note\nAfter it.\n:::')
  const untagged = blockOutline(bob)
  await focus(input(alice, 'Callout title'))
  assert.equal(tags(bob).length, 1)
  assert.equal(proseMirror(bob).querySelector('[data-presence]'), null)
  assert.deepEqual(blockOutline(bob), untagged)
})

test('the innermost block is the one tagged: a spoiler inside a callout', async () => {
  const { alice, bob } = await twoEditors('::::note\nOuter text.\n\n:::details{summary="More"}\nInner text.\n:::\n::::')
  await focus(input(alice, 'Spoiler summary'))
  assert.deepEqual(tags(bob), [{ name: 'alice', on: ['Inner text.'] }])
})

// The browser keeps a positioned element in the place it last fitted, so a
// reused tag would carry that place over from the block it left.
test('a tag that moves to another block is drawn afresh', async () => {
  const { alice, bob } = await twoEditors(
    ':::note\nIn the note.\n:::\n\n:::details{summary="More"}\nIn the spoiler.\n:::',
  )
  await focus(input(alice, 'Callout title'))
  const onNote = bob.container.querySelector('[data-presence]')
  assert.deepEqual(tags(bob), [{ name: 'alice', on: ['In the note.'] }])
  await focus(input(alice, 'Spoiler summary'))
  assert.deepEqual(tags(bob), [{ name: 'alice', on: ['In the spoiler.'] }])
  assert.notEqual(bob.container.querySelector('[data-presence]'), onNote)
})

test('the tag goes when the block whose controls hold the focus is deleted', async () => {
  const { alice, bob } = await twoEditors('Intro.\n\n:::note\nInside the note.\n:::\n\nOutro.')
  await focus(input(alice, 'Callout title'))
  assert.equal(tags(bob).length, 1)
  const editor = (proseMirror(bob) as HTMLElement & { editor: import('@tiptap/core').Editor }).editor
  let callout = -1
  editor.state.doc.forEach((node, offset) => {
    if (node.type.name !== 'paragraph') {
      callout = offset
    }
  })
  await act(async () => {
    editor.chain().setNodeSelection(callout).deleteSelection().run()
  })
  assert.equal(alice.awareness.getLocalState()?.block, null)
  assert.deepEqual(tags(bob), [])
})

test('moving from a block’s controls into the text takes the tag away', async () => {
  const { alice, bob } = await twoEditors(':::details{summary="More"}\nInside the spoiler.\n:::')
  await focus(input(alice, 'Spoiler summary'))
  assert.equal(tags(bob).length, 1)
  await focus(alice.container.querySelector<HTMLElement>('.ProseMirror') as HTMLElement)
  assert.deepEqual(tags(bob), [])
})

test('the tag goes when its editor closes', async () => {
  const { alice, bob } = await twoEditors(':::note\nInside the note.\n:::')
  await focus(input(alice, 'Callout title'))
  assert.equal(tags(bob).length, 1)
  await alice.unmount()
  assert.deepEqual(tags(bob), [])
})

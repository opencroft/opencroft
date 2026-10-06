// Markdown documents served by the collaboration server, end to end on the
// server: loading from a storage, storing back to it, changes made from
// outside an editor, and changes to the storage while documents are closed.
// Exercises the real database (embedded PGlite by default) -- see
// @opencroft/db's test-env -- and an in-process collaboration server.
import '@opencroft/db/test-env'

import assert from 'node:assert/strict'
import { after, before, test } from 'node:test'

import type { Document } from '@hocuspocus/server'
import { initProseMirrorDoc, relativePositionToAbsolutePosition, yXmlFragmentToProsemirrorJSON } from '@tiptap/y-tiptap'
import { markdownConverter, markdownSchema } from 'agent-chat/markdown-schema'
import * as Y from 'yjs'

import { STALE_LINEAGE_REASON } from '@/lib/collab-protocol'
import { MARKDOWN_DOC_FIELD, type MarkdownEditMessage, markdownDocName } from '@/lib/markdown-doc-protocol'
import { getCollabServer } from '@/server/collab/collab-server'
import {
  editMarkdownDoc,
  flushMarkdownDocs,
  markdownDocLineage,
  markdownDocType,
  readMarkdownDoc,
  registerMarkdownDocs,
  registerMarkdownDocType,
  whileMarkdownDocsClosed,
} from '@/server/collab/markdown-docs'

const OWNER = 'test.ext/docs'
const USER = { id: 'user-1', name: 'alice' }
const AGENT = { kind: 'agent', name: 'agent-a' } as const

/** The stored markdown, by key: what an extension's storage would hold. */
const stored = new Map<string, string>()
let writes = 0

before(() => {
  registerMarkdownDocType()
  registerMarkdownDocs(OWNER, {
    read: async (key) => stored.get(key) ?? null,
    write: async (key, markdown) => {
      writes++
      stored.set(key, markdown)
    },
    authorize: (key) => !key.startsWith('private/'),
  })
})

after(async () => {
  const server = getCollabServer()
  for (const document of [...server.documents.values()]) {
    await server.unloadDocument(document)
  }
})

let counter = 0

/** A fresh key holding `markdown`, so no test sees another's document. */
function page(markdown: string): string {
  const key = `page-${++counter}.md`
  stored.set(key, markdown)
  return key
}

/** The first paragraph's text, depth first. */
function firstParagraphText(parent: Y.XmlFragment | Y.XmlElement): Y.XmlText | undefined {
  for (const child of parent.toArray()) {
    if (child instanceof Y.XmlElement) {
      const found = child.nodeName === 'paragraph' ? (child.get(0) as Y.XmlText) : firstParagraphText(child)
      if (found) {
        return found
      }
    }
  }
  return undefined
}

/** Opens the document the way an editor's connection does, and keeps it open until `close` or `leave`. */
async function open(key: string) {
  const connection = await getCollabServer().openDirectConnection(markdownDocName(OWNER, key), {})
  const document = connection.document as Document
  return {
    document,
    /** Types `text` at the end of the document's first paragraph, as an editor would. */
    type: (text: string) =>
      connection.transact((doc) => {
        const textNode = firstParagraphText(doc.getXmlFragment(MARKDOWN_DOC_FIELD))
        assert.ok(textNode, 'the document has a paragraph to type in')
        textNode.insert(textNode.length, text)
      }),
    markdown: () =>
      markdownConverter().serialize(yXmlFragmentToProsemirrorJSON(document.getXmlFragment(MARKDOWN_DOC_FIELD))),
    close: () => connection.disconnect(),
    /** Disconnects but leaves the document in memory with its changes not yet stored, as after an editor's last keystroke. */
    leave: () => connection.disconnect({ unloadImmediately: false }),
  }
}

test('opening and storing a document nobody changed leaves its markdown exactly as stored', async () => {
  // Written the way the converter would not write it: `*` bullets, a soft line break.
  const key = page('* one\n* two\n\nA line\nwrapped.')
  const before = writes
  const doc = await open(key)
  await markdownDocType.store(markdownDocName(OWNER, key), doc.document)
  await doc.close()
  assert.equal(stored.get(key), '* one\n* two\n\nA line\nwrapped.')
  assert.equal(writes, before)
})

test('an edit in the document stores the markdown the editor writes', async () => {
  const key = page('Hello\n\n* one')
  const doc = await open(key)
  await doc.type('!')
  await flushMarkdownDocs(OWNER, key)
  assert.equal(stored.get(key), 'Hello!\n\n- one')
  await doc.close()
})

test('a change to a document nobody has open goes to its storage alone, exactly as made', async () => {
  const key = page('* keep my bullets\n\nold words')
  const next = await editMarkdownDoc(OWNER, key, AGENT, (markdown) => markdown.replace('old', 'new'))
  assert.equal(next, '* keep my bullets\n\nnew words')
  assert.equal(stored.get(key), '* keep my bullets\n\nnew words')
  assert.equal(getCollabServer().documents.has(markdownDocName(OWNER, key)), false)
})

test('a change to an open document nobody changed is stored exactly as made, and the document shows it', async () => {
  const key = page('* keep my bullets\n\nold words')
  const doc = await open(key)
  await editMarkdownDoc(OWNER, key, AGENT, (markdown) => markdown.replace('old', 'new'))
  assert.equal(stored.get(key), '* keep my bullets\n\nnew words')
  assert.equal(doc.markdown(), '- keep my bullets\n\nnew words')
  assert.equal(await readMarkdownDoc(OWNER, key), '* keep my bullets\n\nnew words')
  await doc.close()
})

// A real page: a heading, a paragraph, a list of links. No final newline.
const RICH_PAGE = [
  '# OpenCroft Documentation',
  '',
  'Internal documentation specific to the OpenCroft project. Project-agnostic guides (workflows, tech-stack defaults, coding guidelines, team process) live in the shared `documentation` namespace.',
  '',
  '- [Development](development.md) — dev environment: instances, repos, core-app and extension workflows, gotchas.',
  "- [Agent Permission Modes](agent-modes.md) — the canonical mode list, how each agent's modes map onto it, and how that differs from YOLO / auto-approve.",
  '- [Extension Registries](registry.md) — how extension registries work and how to add one.',
  '- MCP surface: [Extension tools](mcp/extensions.md) · [Git forge tools](mcp/git/index.md)',
].join('\n')

test('a change to an open page nobody changed lands in the open document, not only in its storage', async () => {
  for (const [what, change] of [
    [
      'a sentence replaced',
      (markdown: string) =>
        markdown.replace(
          'Internal documentation specific to the OpenCroft project.',
          'A sentence typed by the agent right here.',
        ),
    ],
    ['a paragraph appended', (markdown: string) => `${markdown}\n\nEdited by the agent.`],
  ] as const) {
    const key = page(RICH_PAGE)
    const doc = await open(key)
    const next = await editMarkdownDoc(OWNER, key, AGENT, change)
    assert.equal(stored.get(key), next, `${what}: stored`)
    assert.equal(
      doc.markdown(),
      markdownConverter().serialize(markdownConverter().parse(next)),
      `${what}: in the open document`,
    )
    await doc.close()
  }
})

test('a change from outside an editor keeps what an editor typed elsewhere in the document', async () => {
  const key = page('First paragraph\n\nSecond paragraph')
  const doc = await open(key)
  await doc.type(' typed')
  await editMarkdownDoc(OWNER, key, AGENT, (markdown) => markdown.replace('Second', 'Changed'))
  assert.equal(doc.markdown(), 'First paragraph typed\n\nChanged paragraph')
  assert.equal(stored.get(key), 'First paragraph typed\n\nChanged paragraph')
  await doc.close()
})

test('every editor is told who changed the document, with a range that finds the new text in its own copy', async () => {
  const key = page('Say hello to everyone')
  const doc = await open(key)
  const messages: MarkdownEditMessage[] = []
  const broadcast = doc.document.broadcastStateless.bind(doc.document)
  doc.document.broadcastStateless = (payload, filter) => {
    messages.push(JSON.parse(payload) as MarkdownEditMessage)
    broadcast(payload, filter)
  }
  await editMarkdownDoc(OWNER, key, AGENT, (markdown) => markdown.replace('hello', 'goodbye'))
  assert.equal(messages.length, 1)
  const [message] = messages
  assert.equal(message.type, 'markdown-edit')
  assert.deepEqual(message.origin, AGENT)
  // A copy elsewhere, synced from the server's, resolves the range in itself.
  const copy = new Y.Doc()
  Y.applyUpdate(copy, Y.encodeStateAsUpdate(doc.document))
  const fragment = copy.getXmlFragment(MARKDOWN_DOC_FIELD)
  const { doc: shown, mapping } = initProseMirrorDoc(fragment, markdownSchema())
  const resolve = (position: unknown) =>
    relativePositionToAbsolutePosition(copy, fragment, Y.createRelativePositionFromJSON(position), mapping)
  const from = resolve(message.from)
  const to = resolve(message.to)
  assert.ok(from !== null && to !== null)
  assert.equal(shown.textBetween(from, to), 'goodbye')
  await doc.close()
})

test('markdown changed in its storage without the document starts a new lineage, and the old copy is refused', async () => {
  const key = page('Version one')
  const name = markdownDocName(OWNER, key)
  const first = await markdownDocLineage(name, USER)
  assert.ok(first)
  await markdownDocType.authorize(name, USER, first)
  stored.set(key, 'Version two')
  const second = await markdownDocLineage(name, USER)
  assert.ok(second)
  assert.notEqual(second, first)
  await assert.rejects(markdownDocType.authorize(name, USER, first), { reason: STALE_LINEAGE_REASON })
})

test('the storage decides who may open a document', async () => {
  const key = page('Secret')
  stored.set(`private/${key}`, 'Secret')
  assert.equal(await markdownDocLineage(markdownDocName(OWNER, `private/${key}`), USER), null)
  assert.ok(await markdownDocLineage(markdownDocName(OWNER, key), USER))
})

test('a document closed for its storage to change is stored first, and reopens on what the change left', async () => {
  const key = page('Hello')
  const doc = await open(key)
  await doc.type(' there')
  await doc.leave()
  const seen = await whileMarkdownDocsClosed(OWNER, [key], async () => {
    assert.equal(getCollabServer().documents.has(markdownDocName(OWNER, key)), false)
    return stored.get(key)
  })
  assert.equal(seen, 'Hello there')
  const reopened = await open(key)
  assert.equal(reopened.markdown(), 'Hello there')
  await reopened.close()
})

test('a discarded document drops what it held, and reopens rebuilt from its storage', async () => {
  const key = page('Published text')
  const name = markdownDocName(OWNER, key)
  const lineage = await markdownDocLineage(name, USER)
  const doc = await open(key)
  await doc.type(' with a draft')
  await flushMarkdownDocs(OWNER, key)
  assert.equal(stored.get(key), 'Published text with a draft')
  await doc.type(' and more')
  await doc.leave()
  // Put back to the published text, as discarding a draft does.
  await whileMarkdownDocsClosed(OWNER, [key], async () => stored.set(key, 'Published text'), { discard: true })
  assert.equal(stored.get(key), 'Published text')
  const reopened = await open(key)
  assert.equal(reopened.markdown(), 'Published text')
  assert.notEqual(await markdownDocLineage(name, USER), lineage)
  await reopened.close()
})

test('a connection asking in while its document is being closed waits, and is not let in onto the closing copy', async () => {
  const key = page('Before')
  const name = markdownDocName(OWNER, key)
  const doc = await open(key)
  const lineage = await markdownDocLineage(name, USER)
  assert.ok(lineage)
  await doc.leave()
  // Started with the document still loaded and its lineage still held: the
  // window a reconnect, or a tab opening the page, lands in.
  const closing = whileMarkdownDocsClosed(OWNER, [key], async () => {
    stored.set(key, 'After')
  })
  const asking = markdownDocType.authorize(name, USER, lineage).then(
    () => 'let in',
    (error: { reason?: string }) => error.reason ?? 'refused',
  )
  const handedOut = markdownDocLineage(name, USER)
  await closing
  // Let in, it would hold the closing copy open and fail the close; it waits,
  // and the markdown having changed meanwhile, its copy is stale.
  assert.equal(await asking, STALE_LINEAGE_REASON)
  const fresh = await handedOut
  assert.ok(fresh)
  assert.notEqual(fresh, lineage)
  const reopened = await open(key)
  assert.equal(reopened.markdown(), 'After')
  await reopened.close()
})

test('a document opened while its owner is closed waits for the change to finish', async () => {
  const key = page('Before')
  const order: string[] = []
  const closing = whileMarkdownDocsClosed(OWNER, null, async () => {
    await new Promise((resolve) => setImmediate(resolve))
    stored.set(key, 'After')
    order.push('changed')
  })
  const opening = open(key).then((doc) => {
    order.push('opened')
    return doc
  })
  await closing
  const doc = await opening
  assert.deepEqual(order, ['changed', 'opened'])
  assert.equal(doc.markdown(), 'After')
  await doc.close()
})

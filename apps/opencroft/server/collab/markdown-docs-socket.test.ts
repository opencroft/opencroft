// A markdown document closed for a change to its storage, with an editor
// connected over a real socket the way a browser is: the app's collaboration
// server on the loopback interface, a signed-in session, and the provider an
// editor holds, kept connected by what the editor keeps it connected with.
// Direct connections never see a close, so these are what shows an editor
// coming back from one.
import '@opencroft/db/test-env'

import assert from 'node:assert/strict'
import type { IncomingMessage } from 'node:http'
import { after, before, test } from 'node:test'

import { HocuspocusProvider, HocuspocusProviderWebsocket } from '@hocuspocus/provider'
import { ensureAuth } from '@opencroft/auth/server'
import { yXmlFragmentToProsemirrorJSON } from '@tiptap/y-tiptap'
import { markdownConverter } from 'agent-chat/markdown-schema'
import { WebSocket, WebSocketServer } from 'ws'
import * as Y from 'yjs'

import { stayConnected } from '@/components/shared-markdown-editor/stay-connected'
import { MARKDOWN_DOC_FIELD, markdownDocName } from '@/lib/markdown-doc-protocol'
import { getCollabServer } from '@/server/collab/collab-server'
import {
  flushMarkdownDocs,
  markdownDocLineage,
  registerMarkdownDocs,
  registerMarkdownDocType,
  whileMarkdownDocsClosed,
} from '@/server/collab/markdown-docs'

const OWNER = 'test.ext/socket-docs'

const stored = new Map<string, string>()
let sockets: WebSocketServer
let url: string
let cookie: string
let user: { id: string; name: string }
const providers: HocuspocusProvider[] = []
const clientSockets: HocuspocusProviderWebsocket[] = []

before(async () => {
  registerMarkdownDocType()
  registerMarkdownDocs(OWNER, {
    read: async (key) => stored.get(key) ?? null,
    write: async (key, markdown) => {
      stored.set(key, markdown)
    },
  })
  // The app's own route hands each socket to the server the same way.
  sockets = new WebSocketServer({ host: '127.0.0.1', port: 0 })
  sockets.on('connection', (socket: WebSocket, incoming: IncomingMessage) => {
    const request = new Request('http://127.0.0.1/api/ws/collab', {
      headers: { cookie: incoming.headers.cookie ?? '' },
    })
    const connection = getCollabServer().handleConnection(socket as never, request)
    socket.on('message', (data: Buffer) => connection.handleMessage(new Uint8Array(data)))
    socket.on('close', (code: number, reason: Buffer) => connection.handleClose({ code, reason: reason.toString() }))
  })
  await new Promise<void>((resolve) => sockets.once('listening', () => resolve()))
  const address = sockets.address()
  assert.ok(address && typeof address === 'object')
  url = `ws://127.0.0.1:${address.port}`

  // Sessions signed with the development secret, as the other session tests do.
  process.env.NODE_ENV = 'development'
  const signedUp = await ensureAuth().api.signUpEmail({
    body: { name: 'Socket Tester', email: 'socket-docs@example.test', password: 'password123456' },
    asResponse: true,
  })
  const setCookie = signedUp.headers.get('set-cookie')
  assert.ok(setCookie, 'signed up')
  cookie = setCookie.split(';')[0]
  user = ((await signedUp.json()) as { user: { id: string; name: string } }).user
})

after(async () => {
  for (const provider of providers) {
    provider.destroy()
  }
  for (const socket of clientSockets) {
    socket.destroy()
  }
  const server = getCollabServer()
  for (const document of [...server.documents.values()]) {
    await server.unloadDocument(document)
  }
  await new Promise<void>((resolve) => sockets.close(() => resolve()))
})

/** A `ws` socket carrying the session cookie, as a browser's would. */
function sessionSocket() {
  return class extends WebSocket {
    constructor(address: string | URL, protocols?: string | string[]) {
      super(address, protocols, { headers: { cookie } })
    }
  }
}

let counter = 0

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

async function until(condition: () => boolean, what: string): Promise<void> {
  const deadline = Date.now() + 10_000
  while (!condition()) {
    if (Date.now() > deadline) {
      assert.fail(`timed out waiting for ${what}`)
    }
    await new Promise((resolve) => setTimeout(resolve, 10))
  }
}

/** An editor's connection to a document: a provider over its own socket, kept connected as the editor keeps it. */
async function connect(key: string) {
  const name = markdownDocName(OWNER, key)
  const lineage = await markdownDocLineage(name, user)
  assert.ok(lineage, 'the document opens')
  const doc = new Y.Doc()
  let stale = 0
  const websocketProvider = new HocuspocusProviderWebsocket({ url, WebSocketPolyfill: sessionSocket() })
  clientSockets.push(websocketProvider)
  const provider = new HocuspocusProvider({
    websocketProvider,
    name,
    document: doc,
    token: lineage,
  })
  providers.push(provider)
  provider.attach()
  const stop = stayConnected(provider, { onStale: () => stale++ })
  await until(() => provider.synced, 'the first sync')
  return {
    provider,
    stale: () => stale,
    markdown: () =>
      markdownConverter().serialize(yXmlFragmentToProsemirrorJSON(doc.getXmlFragment(MARKDOWN_DOC_FIELD))),
    /** Types at the end of the first paragraph, as an editor would. */
    type: (text: string) => {
      const textNode = firstParagraphText(doc.getXmlFragment(MARKDOWN_DOC_FIELD))
      assert.ok(textNode, 'a paragraph to type in')
      doc.transact(() => textNode.insert(textNode.length, text))
    },
    stop,
  }
}

test('an editor whose document was closed, stored and reopened unchanged comes back, and what it types is stored', async () => {
  const key = page('Hello.')
  const editor = await connect(key)
  editor.type(' One')
  await until(() => editor.provider.unsyncedChanges === 0, 'the first edit to reach the server')

  await whileMarkdownDocsClosed(OWNER, [key], async () => {})
  assert.equal(stored.get(key), 'Hello. One', 'stored before it was closed')

  // Typed straight after the close: it reaches the server once the editor
  // is let back in.
  editor.type(' Two')
  await until(
    () => editor.provider.isAuthenticated && editor.provider.unsyncedChanges === 0,
    'the editor to be let back in',
  )
  await until(() => getCollabServer().documents.has(markdownDocName(OWNER, key)), 'the document to be open again')
  await flushMarkdownDocs(OWNER, key)
  assert.equal(stored.get(key), 'Hello. One Two')
  assert.equal(editor.stale(), 0, 'the same copy goes on')
})

test('an editor whose draft was discarded is told its copy is stale, and a fresh one holds what the change left', async () => {
  const key = page('Published text.')
  const editor = await connect(key)
  editor.type(' Draft.')
  await until(() => editor.provider.unsyncedChanges === 0, 'the edit to reach the server')

  await whileMarkdownDocsClosed(
    OWNER,
    [key],
    async () => {
      stored.set(key, 'Published text.')
    },
    { discard: true },
  )
  await until(() => editor.stale() > 0, 'the stale refusal')

  const fresh = await connect(key)
  assert.equal(fresh.markdown(), 'Published text.')
})

test('an editor whose document was changed while closed is told its copy is stale, and a fresh one holds the change', async () => {
  const key = page('Before.')
  const editor = await connect(key)
  await whileMarkdownDocsClosed(OWNER, [key], async () => {
    // A pull bringing in someone else's edit to the page.
    stored.set(key, 'After.')
  })
  await until(() => editor.stale() > 0, 'the open editor to be told')
  const fresh = await connect(key)
  assert.equal(fresh.markdown(), 'After.')
})

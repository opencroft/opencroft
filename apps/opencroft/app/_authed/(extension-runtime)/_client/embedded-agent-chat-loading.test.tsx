// While the embedded chat loads -- the chat, its home screen with the thread
// list, or the thread it was asked for -- the panel shows only the loader: no
// empty composer frame under it. All three draw the same loading state, and
// the surface starts out in it, so server rendering, which runs no effects,
// shows exactly that state with nothing reaching for a server.
//
// WHAT THIS DOES NOT COVER: the home screen and the thread lookup reaching
// that state (each returns the same component, by reading), and the layout a
// reader sees, which only a browser shows.
import assert from 'node:assert/strict'
import test, { after } from 'node:test'

import { installDomEnvironment } from '@/test-support/dom-environment'

const dom = await installDomEnvironment()

const { createElement } = await import('react')
const { renderToStaticMarkup } = await import('react-dom/server')
const { EmbeddedAgentChat } = await import('./embedded-agent-chat')
const { SSEEventsProvider } = await import('@/app/_authed/(sse)/_lib/sse-events-store')

after(() => dom.cleanup())

test('the embedded chat shows only the loader while it loads, with no composer frame under it', () => {
  const container = document.createElement('div')
  container.innerHTML = renderToStaticMarkup(
    // The provider every authed page mounts; the surface reads graph changes from it.
    createElement(SSEEventsProvider, null, createElement(EmbeddedAgentChat, { space: 'a-space', id: 'a-thread' })),
  )
  // Booleans, not the elements: printing a jsdom element in a failure message
  // walks the whole document and the run dies before it reports.
  const has = (selector: string) => container.querySelector(selector) !== null
  assert.equal(has('svg[aria-label="Loading"]'), true, 'the loader is shown while the chat loads')
  // The composer frame is a node card; the stand-in it used to hold was an
  // empty block the composer's height.
  assert.equal(has('.shadow-node-shadow'), false, 'no composer frame under the loader')
  assert.equal(has('.h-16'), false, 'no composer stand-in under the loader')
  assert.equal(has('textarea'), false)
})

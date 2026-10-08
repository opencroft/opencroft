// While a thread's conversation opens, the loader stands alone: no composer and
// no composer frame under it, in the embedded frame and in a host's own frame.
//
// A session starts out opening, and server rendering runs no effects, so the
// real host rendered to markup is exactly that first state, with nothing
// reaching for a server. The loader's presence is asserted first, so an absent
// composer cannot pass for a render that showed something else.
//
// WHAT THIS DOES NOT COVER: the composer arriving once the open answers, and
// staying through a Clear -- group-chat-thread-opening.test.tsx mounts the host
// with its effects for those -- and the layout a reader sees, which only a
// browser shows.
import assert from 'node:assert/strict'
import test, { after } from 'node:test'

import type { ReactNode } from 'react'

import { installDomEnvironment } from '@/test-support/dom-environment'

const dom = await installDomEnvironment()

const { createElement } = await import('react')
const { renderToStaticMarkup } = await import('react-dom/server')
const { GroupChatThreadChat } = await import('./group-chat-thread-chat')
const { GroupChatThreadFraming } = await import('ui/group-chat/group-chat-thread-framing')

after(() => dom.cleanup())

type Props = Parameters<typeof GroupChatThreadChat>[0]

const THREAD: Props['thread'] = {
  id: 'thread-1',
  groupChatId: 'chat-1',
  title: 'A thread',
  agent: { nodeId: 'agent-1', name: 'Ada', avatarUrl: null },
  createdAt: new Date(0),
  sessionKey: 'session-key-1',
  agentIsMember: true,
  hasDraft: false,
  archived: false,
  draft: null,
  queue: { items: [] },
}

function render(props: Partial<Props>): HTMLElement {
  const container = document.createElement('div')
  container.innerHTML = renderToStaticMarkup(createElement(GroupChatThreadChat, { thread: THREAD, ...props }))
  return container
}

function assertLoaderAlone(container: HTMLElement): void {
  // Booleans, not the elements: printing a jsdom element in a failure message
  // walks the whole document and the run dies before it reports.
  const has = (selector: string) => container.querySelector(selector) !== null
  assert.equal(has('svg[aria-label="Loading"]'), true, 'the loader is shown while the thread opens')
  assert.equal(has('textarea'), false, 'no composer under the loader')
  assert.equal(has('.sticky'), false, 'no pinned composer area under the loader')
}

test('the embedded frame shows only the loader while the thread opens', () => {
  assertLoaderAlone(render({}))
})

test('an archived thread shows only the loader while it opens, not the archive notice', () => {
  const container = render({ thread: { ...THREAD, archived: true } })
  assertLoaderAlone(container)
  assert.doesNotMatch(container.textContent ?? '', /archived/i)
})

test('a host frame is handed no composer while the thread opens', () => {
  const composers: ReactNode[] = []
  render({
    renderFrame: ({ conversation, composer }) => {
      composers.push(composer)
      return conversation
    },
  })
  assert.equal(composers.length, 1, 'the frame was rendered once')
  assert.equal(composers[0], undefined)
})

test('the thread framing draws no composer dock while the thread opens', () => {
  assertLoaderAlone(
    render({
      renderFrame: ({ conversation, composer }) =>
        createElement(GroupChatThreadFraming, {
          groupChatName: 'A chat',
          threadTitle: 'A thread',
          composer,
          children: conversation,
        }),
    }),
  )
})

// A cold load's first paint is this markup, and it stands until the page's
// code has loaded -- on a slow connection most of the loading time. A queue the
// thread was read with is under the loader from that first paint.
test('a message waiting for the agent shows under the loader from the first paint', () => {
  const container = render({
    thread: {
      ...THREAD,
      queue: {
        items: [
          {
            id: 'q-1',
            kind: 'message',
            sender: 'someone',
            sentAt: '2026-10-08T12:00:00.000Z',
            text: 'Queued second message',
          },
        ],
      },
    },
  })
  assertLoaderAlone(container)
  assert.match(container.textContent ?? '', /Queued second message/)
})

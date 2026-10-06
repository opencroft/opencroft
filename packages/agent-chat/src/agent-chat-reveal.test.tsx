// Opening a conversation at a turn, mounted for real under StrictMode -- the
// way a host renders it in development, where React runs every mount effect a
// second time. The conversation lands at its end when its session changes; a
// reveal that arrives with the first render must not be undone by that
// landing running again.
//
// jsdom lays nothing out, so the scroll viewport is given a size and a scroll
// position of its own, and a turn's section reports where its content sits.
import assert from 'node:assert/strict'
import { after, afterEach, before, test } from 'node:test'

import type { ChatMessage } from 'agent-client/fold'
import type { ReactNode } from 'react'

import { installTestDom } from './test-dom'

const SCROLL_HEIGHT = 3000
const CLIENT_HEIGHT = 500
// Where the revealed turn's section starts, in content coordinates.
const TURN_TOP = 1200

let container: HTMLElement
let root: import('react-dom/client').Root | null = null
let act: typeof import('react').act
let StrictMode: typeof import('react').StrictMode
let createRoot: typeof import('react-dom/client').createRoot
let AgentChat: typeof import('./agent-chat').AgentChat
let buildKitBlocks: typeof import('./kit-blocks').buildKitBlocks

before(async () => {
  container = installTestDom()
  const globals = globalThis as unknown as Record<string, unknown>
  globals.ResizeObserver = class {
    observe() {}
    disconnect() {}
  }
  // The viewport's size and scroll position. On the prototype rather than the
  // element, because the conversation's mount effects run before a parent's
  // ref callback could set them on the element.
  const isViewport = (element: HTMLElement) => element.dataset.slot === 'scroll-area-viewport'
  const scrollTops = new WeakMap<HTMLElement, number>()
  Object.defineProperties(window.HTMLElement.prototype, {
    scrollHeight: {
      configurable: true,
      get: function (this: HTMLElement) {
        return isViewport(this) ? SCROLL_HEIGHT : 0
      },
    },
    clientHeight: {
      configurable: true,
      get: function (this: HTMLElement) {
        return isViewport(this) ? CLIENT_HEIGHT : 0
      },
    },
    scrollTop: {
      configurable: true,
      get: function (this: HTMLElement) {
        return scrollTops.get(this) ?? 0
      },
      set: function (this: HTMLElement, value: number) {
        scrollTops.set(this, value)
      },
    },
  })
  window.HTMLElement.prototype.scrollBy = function (this: HTMLElement, x?: number | ScrollToOptions, y?: number) {
    this.scrollTop += typeof x === 'number' ? (y ?? 0) : (x?.top ?? 0)
  } as typeof HTMLElement.prototype.scrollBy
  // A turn's section reports its content position against the viewport's
  // scroll; everything else sits at the top.
  window.HTMLElement.prototype.getBoundingClientRect = function (this: HTMLElement) {
    const viewport = this.closest('[data-slot="scroll-area-viewport"]') as HTMLElement | null
    const top =
      this.hasAttribute('data-turn-section') && this.querySelector('[data-block-id="u:5"]') && viewport
        ? TURN_TOP - viewport.scrollTop
        : 0
    return new window.DOMRect(0, top, 0, 0)
  }
  ;({ act, StrictMode } = await import('react'))
  ;({ createRoot } = await import('react-dom/client'))
  ;({ AgentChat } = await import('./agent-chat'))
  ;({ buildKitBlocks } = await import('./kit-blocks'))
})

afterEach(async () => {
  const current = root
  root = null
  if (current) {
    await act(async () => current.unmount())
  }
})

after(() => {
  container.innerHTML = ''
})

const messages: ChatMessage[] = [
  { id: '1', kind: 'user', text: 'first question' },
  { id: '2', kind: 'assistant', text: 'first answer' },
  { id: '5', kind: 'user', text: 'the question searched for' },
  { id: '6', kind: 'assistant', text: 'its answer' },
  { id: '9', kind: 'user', text: 'the newest question' },
  { id: '10', kind: 'assistant', text: 'the newest answer' },
]

// The host's components for a turn's parts. Scroll position is what is
// measured here, not what a part draws, so every one of them passes its
// children through.
const renderers = new Proxy(
  {},
  { get: () => (props: { children?: ReactNode }) => <div>{props.children}</div> },
) as import('./components/chat-turn').ChatTurnRenderers

function session(sessionKey: string, loading: boolean) {
  return {
    sessionKey,
    loading,
    sending: false,
    waiting: false,
    botName: 'Agent A',
    send: () => {},
    hasMoreHistory: false,
  }
}

// The scroll region a host wraps the conversation in.
function Viewport({ children }: { children: ReactNode }) {
  return <div data-slot='scroll-area-viewport'>{children}</div>
}

async function render(node: ReactNode) {
  root ??= createRoot(container)
  const current = root
  await act(async () => current.render(<StrictMode>{node}</StrictMode>))
}

const scrollTop = () => (container.querySelector('[data-slot="scroll-area-viewport"]') as HTMLElement).scrollTop

test('a reveal that arrives before the conversation has loaded opens it at the turn', async () => {
  const settled: boolean[] = []
  const reveal = { blockIds: ['u:5', 't:5'], onSettled: (found: boolean) => settled.push(found) }
  const blocks = buildKitBlocks(messages)
  // Asked for while the session is still loading: the conversation is not
  // mounted yet, so the reveal is applied in the commit that mounts it.
  await render(
    <Viewport>
      <AgentChat
        session={session('session-1', true)}
        blocks={blocks}
        hasMessages
        renderers={renderers}
        renderTool={() => null}
        reveal={reveal}
      />
    </Viewport>,
  )
  await render(
    <Viewport>
      <AgentChat
        session={session('session-1', false)}
        blocks={blocks}
        hasMessages
        renderers={renderers}
        renderTool={() => null}
        reveal={reveal}
      />
    </Viewport>,
  )
  assert.deepEqual(settled, [true])
  assert.equal(scrollTop(), TURN_TOP)
})

test('a conversation opened without a reveal lands at its end', async () => {
  await render(
    <Viewport>
      <AgentChat
        session={session('session-2', false)}
        blocks={buildKitBlocks(messages)}
        hasMessages
        renderers={renderers}
        renderTool={() => null}
      />
    </Viewport>,
  )
  assert.equal(scrollTop(), SCROLL_HEIGHT)
})

test("switching to another session after a reveal lands at the new one's end", async () => {
  const reveal = { blockIds: ['u:5'] }
  const blocks = buildKitBlocks(messages)
  await render(
    <Viewport>
      <AgentChat
        session={session('session-3', false)}
        blocks={blocks}
        hasMessages
        renderers={renderers}
        renderTool={() => null}
        reveal={reveal}
      />
    </Viewport>,
  )
  assert.equal(scrollTop(), TURN_TOP)
  await render(
    <Viewport>
      <AgentChat
        session={session('session-4', false)}
        blocks={[...blocks]}
        hasMessages
        renderers={renderers}
        renderTool={() => null}
        reveal={reveal}
      />
    </Viewport>,
  )
  assert.equal(scrollTop(), SCROLL_HEIGHT)
})

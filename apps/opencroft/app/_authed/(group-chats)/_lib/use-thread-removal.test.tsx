// When the open thread stops being reachable, and when it does not.
//
// Driven the way the page is: the server's chat change arrives through
// `receiveGroupChatChange`, the hook asks the injected lookup, and the answer
// decides. The lookup is a stand-in for `findGroupChatThreadInChat`, settled
// by each test, so the order of answers is the test's to choose.
//
// WHAT THIS DOES NOT COVER: where each surface sends the reader (the route's
// redirect, the dock's home selection) and that the server announces a change
// on a delete. Those are read, not exercised here.
import assert from 'node:assert/strict'
import test, { after } from 'node:test'

import { installDomEnvironment } from '@/test-support/dom-environment'

const dom = await installDomEnvironment()

const { act, createElement } = await import('react')
const { createRoot } = await import('react-dom/client')
const { receiveGroupChatChange } = await import('@/app/_authed/(group-chats)/_lib/group-chat-changes')
const { useThreadRemoval } = await import('@/app/_authed/(group-chats)/_lib/use-thread-removal')

type Lookup = import('@/app/_authed/(group-chats)/_lib/use-thread-removal').ThreadLookup
type Removal = import('@/app/_authed/(group-chats)/_lib/use-thread-removal').ThreadRemoval
type Answer = Awaited<ReturnType<Lookup>>

after(() => dom.cleanup())

/** A lookup whose answers the test hands out, one per question, in order. */
function scriptedLookup() {
  const asked: Array<{ groupChatId: string; threadId: string }> = []
  const pending: Array<{ resolve: (answer: Answer) => void; reject: (error: unknown) => void }> = []
  const lookup: Lookup = (ids) => {
    asked.push(ids)
    return new Promise<Answer>((resolve, reject) => {
      pending.push({ resolve, reject })
    })
  }
  return {
    lookup,
    asked,
    answer: (answer: Answer) => pending.shift()?.resolve(answer),
    fail: () => pending.shift()?.reject(new Error('network down')),
  }
}

const OK: Answer = {
  state: 'ok',
  thread: {} as Extract<Answer, { state: 'ok' }>['thread'],
}

// Lets every promise callback queued so far run, inside act.
async function settle() {
  await act(async () => {
    // biome-ignore lint/plugin/noTestFixedTime: zero-delay turn that lets the queued promise callbacks run inside act
    await new Promise((resolve) => setTimeout(resolve, 0))
  })
}

async function mount(lookup: Lookup, threadId = 'thread-a') {
  const removals: Removal[] = []
  let current = threadId
  function Harness({ open }: { open: string }) {
    useThreadRemoval('chat-1', open, lookup, (removal) => removals.push(removal))
    return null
  }
  const root = createRoot(dom.container)
  await act(async () => {
    root.render(createElement(Harness, { open: current }))
  })
  return {
    removals,
    open: async (next: string) => {
      current = next
      await act(async () => {
        root.render(createElement(Harness, { open: current }))
      })
    },
    unmount: async () => {
      await act(async () => {
        root.unmount()
      })
    },
  }
}

test('a change to another chat asks nothing', async () => {
  const script = scriptedLookup()
  const view = await mount(script.lookup)
  receiveGroupChatChange('chat-2')
  receiveGroupChatChange('chat-1')
  assert.deepEqual(script.asked, [{ groupChatId: 'chat-1', threadId: 'thread-a' }], 'only the own chat is asked about')
  script.answer(OK)
  await settle()
  await view.unmount()
})

test('a thread still in the chat leaves the reader where they are', async () => {
  const script = scriptedLookup()
  const view = await mount(script.lookup)
  receiveGroupChatChange('chat-1')
  script.answer(OK)
  await settle()
  assert.equal(script.asked.length, 1)
  assert.deepEqual(view.removals, [])
  await view.unmount()
})

test('a deleted thread is reported once, however many changes ask', async () => {
  const script = scriptedLookup()
  const view = await mount(script.lookup)
  receiveGroupChatChange('chat-1')
  receiveGroupChatChange('chat-1')
  script.answer({ state: 'gone' })
  script.answer({ state: 'gone' })
  await settle()
  assert.deepEqual(view.removals, ['gone'])
  await view.unmount()
})

test('a chat the reader left is reported as refused', async () => {
  const script = scriptedLookup()
  const view = await mount(script.lookup)
  receiveGroupChatChange('chat-1')
  script.answer({ state: 'refused' })
  await settle()
  assert.deepEqual(view.removals, ['refused'])
  await view.unmount()
})

test('a failed lookup moves nobody, and the next change asks again', async () => {
  const script = scriptedLookup()
  const view = await mount(script.lookup)
  receiveGroupChatChange('chat-1')
  script.fail()
  await settle()
  assert.deepEqual(view.removals, [], 'a failure is not an answer about the thread')
  receiveGroupChatChange('chat-1')
  script.answer({ state: 'gone' })
  await settle()
  assert.deepEqual(view.removals, ['gone'])
  await view.unmount()
})

test('an answer that arrives after the thread was left is dropped', async () => {
  const script = scriptedLookup()
  const view = await mount(script.lookup)
  receiveGroupChatChange('chat-1')
  await view.unmount()
  script.answer({ state: 'gone' })
  await settle()
  assert.deepEqual(view.removals, [])
})

test('an answer about the thread before a switch does not move the reader off the next one', async () => {
  const script = scriptedLookup()
  const view = await mount(script.lookup)
  receiveGroupChatChange('chat-1')
  await view.open('thread-b')
  script.answer({ state: 'gone' })
  await settle()
  assert.deepEqual(view.removals, [], 'thread-a was asked about; thread-b is open')
  receiveGroupChatChange('chat-1')
  assert.deepEqual(script.asked.at(-1), { groupChatId: 'chat-1', threadId: 'thread-b' })
  script.answer({ state: 'gone' })
  await settle()
  assert.deepEqual(view.removals, ['gone'])
  await view.unmount()
})

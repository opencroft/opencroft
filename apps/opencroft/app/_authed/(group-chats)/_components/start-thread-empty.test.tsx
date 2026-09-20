// Starting a thread with nothing typed.
//
// The rule has two halves that disagree on purpose: THE SEND BUTTON starts an
// empty thread, and ENTER does not. The button names what it does and is
// pressed deliberately; Enter is the keystroke a person hits without looking at
// what it will hit, and the two must not mean the same thing here.
//
// Pinned against the real composer rather than described, because the halves
// live in two different kit components -- the permission is a prop on the start
// composer, the gate it turns into is inside the command bar -- and neither
// package has a DOM to exercise them in. This is the only place the pair is
// reachable at once.
//
// The last test is the regression the message PARAMETER closed. The host used
// to keep its own copy of the last non-empty text, to survive the command bar
// clearing the composer before reporting the send. That was correct exactly as
// long as an empty submit was impossible: the moment one became possible, a
// person who typed something, deleted it and then started an empty thread would
// have sent the deleted text.

import assert from 'node:assert/strict'
import test, { after } from 'node:test'

import type { ReactNode } from 'react'

import { installDomEnvironment } from '@/test-support/dom-environment'

const dom = await installDomEnvironment()

const { act, useState } = await import('react')
const { createRoot } = await import('react-dom/client')
const { StartThreadComposer } = await import('ui/group-chat/start-thread-composer')

after(() => dom.cleanup())

const AGENTS = [{ nodeId: 'agent-1', name: 'Ada' }]
// The composer's own wording for the press, not the host's -- see the prop.
const EMPTY_LABEL = 'Start the thread without a message'

// Captured during render, so a test can put text in the composer and take it
// out again without simulating keystrokes into a controlled textarea. What is
// under test is the props contract, and this drives it directly.
let setText: ((value: string) => void) | null = null

interface SurfaceProps {
  allowEmptyStart: boolean
  onSubmit: (message: string) => void
}

function Surface({ allowEmptyStart, onSubmit }: SurfaceProps): ReactNode {
  const [value, setValue] = useState('')
  setText = setValue
  return (
    <StartThreadComposer
      agents={AGENTS}
      selectedAgentNodeId='agent-1'
      onSelectAgent={() => {}}
      value={value}
      onValueChange={setValue}
      allowEmptyStart={allowEmptyStart}
      onSubmit={onSubmit}
    />
  )
}

interface View {
  /** The send button, found by the name it currently carries. */
  send: () => HTMLButtonElement
  type: (text: string) => Promise<void>
  click: () => Promise<void>
  enter: () => Promise<void>
  unmount: () => Promise<void>
}

async function mount(options: { allowEmptyStart: boolean; onSubmit: (message: string) => void }): Promise<View> {
  setText = null
  const root = createRoot(dom.container)
  await act(async () => {
    root.render(<Surface allowEmptyStart={options.allowEmptyStart} onSubmit={options.onSubmit} />)
  })
  const send = () => {
    const found = dom.container.querySelector(`button[aria-label="Send"], button[aria-label="${EMPTY_LABEL}"]`)
    assert.ok(found, 'the send button is on screen')
    return found as HTMLButtonElement
  }
  return {
    send,
    type: async (text: string) => {
      assert.ok(setText, 'the surface rendered')
      await act(async () => setText?.(text))
    },
    click: async () => {
      await act(async () => {
        send().click()
      })
    },
    enter: async () => {
      const textarea = dom.container.querySelector('textarea')
      assert.ok(textarea, 'the composer has a message field')
      await act(async () => {
        textarea.dispatchEvent(new window.KeyboardEvent('keydown', { key: 'Enter', bubbles: true }))
      })
    },
    unmount: async () => {
      await act(async () => root.unmount())
    },
  }
}

test('without the offer, an empty composer cannot be sent and the button says Send', async () => {
  const submitted: string[] = []
  const view = await mount({ allowEmptyStart: false, onSubmit: (message) => submitted.push(message) })

  assert.equal(view.send().getAttribute('aria-label'), 'Send')
  assert.ok(view.send().disabled, 'the button is unavailable with nothing typed')
  await view.click()
  assert.deepEqual(submitted, [], 'a disabled button reports nothing')
  await view.unmount()
})

test('with the offer, an empty composer starts the thread and the button says so', async () => {
  const submitted: string[] = []
  const view = await mount({ allowEmptyStart: true, onSubmit: (message) => submitted.push(message) })

  // The name is half the rule: a press that sends no message must not claim to
  // be a send, or the button is describing the one thing it will not do.
  assert.equal(view.send().getAttribute('aria-label'), EMPTY_LABEL)
  assert.equal(view.send().disabled, false, 'the button is available with nothing typed')
  await view.click()
  assert.deepEqual(submitted, [''], 'the start is reported with no message')
  await view.unmount()
})

test('Enter in an empty composer starts nothing, offer or no offer', async () => {
  const submitted: string[] = []
  const view = await mount({ allowEmptyStart: true, onSubmit: (message) => submitted.push(message) })

  await view.enter()
  assert.deepEqual(submitted, [], 'the keystroke is not the press')

  // The discriminating control: the same keystroke on the same composer DOES
  // send once there is something to send, so what the test above pinned is the
  // empty case rather than a keydown that never arrived.
  await view.type('ship it')
  await view.enter()
  assert.deepEqual(submitted, ['ship it'])
  await view.unmount()
})

test('text that was typed and then deleted is not what gets started', async () => {
  const submitted: string[] = []
  const view = await mount({ allowEmptyStart: true, onSubmit: (message) => submitted.push(message) })

  await view.type('never mind')
  await view.type('')
  assert.equal(view.send().getAttribute('aria-label'), EMPTY_LABEL, 'the composer is empty again')

  await view.click()
  assert.deepEqual(submitted, [''], 'the deleted text is gone, not remembered')
  await view.unmount()
})

// The Sessions tab's chat history settings, rendered for real: both off by
// default, each saying what it removes, and saved together with what was
// typed. Rendered here because neither packages/ui nor the kit has a DOM to
// render the component in.

import assert from 'node:assert/strict'
import test, { after } from 'node:test'

import type { AgentChatHistory } from 'ui/settings/agent-sessions'

import { installDomEnvironment } from '@/test-support/dom-environment'

const dom = await installDomEnvironment()

const { act } = await import('react')
const { createRoot } = await import('react-dom/client')
const { AgentSessions } = await import('ui/settings/agent-sessions')

after(() => dom.cleanup())

async function render(chatHistory: AgentChatHistory | null, onChange: (next: AgentChatHistory) => void = () => {}) {
  const root = createRoot(dom.container)
  await act(async () => {
    root.render(
      <AgentSessions
        sleepEnabled={false}
        onToggleSleep={() => {}}
        yoloEnabled={false}
        onToggleYolo={() => {}}
        sessions={[]}
        backgroundTasks={[]}
        chatHistory={chatHistory}
        onChatHistoryChange={onChange}
      />,
    )
  })
  const heading = Array.from(dom.container.querySelectorAll('div')).find((el) => el.textContent === 'Chat history')
  const card = heading?.closest('.rounded-lg')
  assert.ok(card, 'the page draws a chat history card')
  const inputs = Array.from(card.querySelectorAll('input')) as HTMLInputElement[]
  const save = Array.from(card.querySelectorAll('button')).find((el) => el.textContent === 'Save') as HTMLButtonElement
  return {
    card,
    limit: inputs[0],
    days: inputs[inputs.length - 1],
    save,
    unmount: async () => {
      await act(async () => root.unmount())
    },
  }
}

// Type into a React-controlled input the way a reader does.
async function type(input: HTMLInputElement, value: string) {
  const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value')?.set
  await act(async () => {
    setter?.call(input, value)
    input.dispatchEvent(new window.Event('input', { bubbles: true }))
  })
}

test('with both settings off, the card says everything is kept, shows no limit and no cleanup, and has nothing to save', async () => {
  const view = await render({ maxEntries: null, cleanupAfterDays: null })
  assert.match(view.card.textContent ?? '', /keeps its whole chat history/)
  assert.match(view.card.textContent ?? '', /removes the older ones, a whole turn at a time/)
  assert.match(view.card.textContent ?? '', /Removes the turns that started more than this many days ago/)
  assert.equal(view.limit.value, '')
  assert.equal(view.days.disabled, true, 'the days wait for the switch')
  assert.equal(view.save.disabled, true)
  await view.unmount()
})

test('a limit typed in is saved with the cleanup left off', async () => {
  const saved: AgentChatHistory[] = []
  const view = await render({ maxEntries: null, cleanupAfterDays: null }, (next) => saved.push(next))
  await type(view.limit, '5000')
  assert.equal(view.save.disabled, false)
  await act(async () => view.save.click())
  assert.deepEqual(saved, [{ maxEntries: 5000, cleanupAfterDays: null }])
  await view.unmount()
})

test('a limit that is not a whole number of 1 or more cannot be saved', async () => {
  const view = await render({ maxEntries: null, cleanupAfterDays: null })
  await type(view.limit, '0')
  assert.equal(view.save.disabled, true)
  assert.match(view.card.textContent ?? '', /whole number of 1 or more/)
  await view.unmount()
})

test('stored settings show as set, and clearing the limit saves it as none', async () => {
  const saved: AgentChatHistory[] = []
  const view = await render({ maxEntries: 3000, cleanupAfterDays: 90 }, (next) => saved.push(next))
  assert.equal(view.limit.value, '3000')
  assert.equal(view.days.value, '90')
  assert.equal(view.days.disabled, false)
  await type(view.limit, '')
  await act(async () => view.save.click())
  assert.deepEqual(saved, [{ maxEntries: null, cleanupAfterDays: 90 }])
  await view.unmount()
})

test('settings not read yet are not drawn as off: nothing can be edited', async () => {
  const view = await render(null)
  assert.equal(view.limit.disabled, true)
  assert.equal(view.save.disabled, true)
  await view.unmount()
})

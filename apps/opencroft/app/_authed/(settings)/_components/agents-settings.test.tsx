// The Agents section's tabs: the open tab's panel is the only one mounted, so
// the other tab's polling is not running, and picking a tab is reported to
// the host rather than kept here, so the host can hold it in the URL.

import assert from 'node:assert/strict'
import test, { after } from 'node:test'

import type { AgentsSettingsTab } from 'ui/settings/agents-settings'

import { installDomEnvironment } from '@/test-support/dom-environment'

const dom = await installDomEnvironment()

// The tab panels schedule through animation frames; jsdom has the frame
// functions on its window but not on `globalThis`, and without them the first
// render throws.
const win = globalThis.window as unknown as Record<string, unknown>
const globals = globalThis as unknown as Record<string, unknown>
for (const name of ['requestAnimationFrame', 'cancelAnimationFrame']) {
  globals[name] = (win[name] as (...args: unknown[]) => unknown).bind(win)
}

const { act } = await import('react')
const { createRoot } = await import('react-dom/client')
const { AgentsSettings } = await import('ui/settings/agents-settings')

after(() => dom.cleanup())

async function render(tab: AgentsSettingsTab, onTabChange: (tab: AgentsSettingsTab) => void = () => {}) {
  const root = createRoot(dom.container)
  await act(async () => {
    root.render(
      <AgentsSettings
        tab={tab}
        onTabChange={onTabChange}
        sessions={<p>sessions panel</p>}
        audit={<p>audit panel</p>}
      />,
    )
  })
  return {
    text: () => dom.container.textContent ?? '',
    tab: (label: string) =>
      Array.from(dom.container.querySelectorAll('[role="tab"]')).find((el) => el.textContent === label) as
        | HTMLElement
        | undefined,
    unmount: async () => {
      await act(async () => root.unmount())
    },
  }
}

test('both tabs are offered, Sessions first', async () => {
  const view = await render('sessions')
  const labels = Array.from(dom.container.querySelectorAll('[role="tab"]')).map((el) => el.textContent)
  assert.deepEqual(labels, ['Sessions', 'MCP Audit'])
  await view.unmount()
})

test('only the open tab panel is mounted', async () => {
  const sessions = await render('sessions')
  assert.match(sessions.text(), /sessions panel/)
  assert.doesNotMatch(sessions.text(), /audit panel/)
  await sessions.unmount()

  const audit = await render('audit')
  assert.match(audit.text(), /audit panel/)
  assert.doesNotMatch(audit.text(), /sessions panel/)
  await audit.unmount()
})

test('picking the other tab is reported to the host', async () => {
  const picked: AgentsSettingsTab[] = []
  const view = await render('sessions', (tab) => picked.push(tab))
  const trigger = view.tab('MCP Audit')
  assert.ok(trigger, 'the MCP Audit tab is drawn')
  await act(async () => {
    trigger.click()
  })
  assert.deepEqual(picked, ['audit'])
  await view.unmount()
})

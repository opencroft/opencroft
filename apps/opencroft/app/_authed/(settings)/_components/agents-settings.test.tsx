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
        usage={<p>usage panel</p>}
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

test('the three tabs are offered: Sessions, Usage, MCP Audit', async () => {
  const view = await render('sessions')
  const labels = Array.from(dom.container.querySelectorAll('[role="tab"]')).map((el) => el.textContent)
  assert.deepEqual(labels, ['Sessions', 'Usage', 'MCP Audit'])
  await view.unmount()
})

test('only the open tab panel is mounted', async () => {
  const panels = ['sessions', 'usage', 'audit'] as const
  for (const open of panels) {
    const view = await render(open)
    for (const panel of panels) {
      const text = new RegExp(`${panel} panel`)
      if (panel === open) {
        assert.match(view.text(), text, `${open}: its own panel`)
      } else {
        assert.doesNotMatch(view.text(), text, `${open}: not the ${panel} panel`)
      }
    }
    await view.unmount()
  }
})

test('picking the other tab is reported to the host', async () => {
  const picked: AgentsSettingsTab[] = []
  const view = await render('sessions', (tab) => picked.push(tab))
  for (const label of ['Usage', 'MCP Audit']) {
    const trigger = view.tab(label)
    assert.ok(trigger, `the ${label} tab is drawn`)
    await act(async () => {
      trigger.click()
    })
  }
  assert.deepEqual(picked, ['usage', 'audit'])
  await view.unmount()
})

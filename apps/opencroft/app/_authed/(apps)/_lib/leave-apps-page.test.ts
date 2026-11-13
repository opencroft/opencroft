// Leaving the Apps page rewrites its own entry and then opens the target as a
// new one, so Back lands on the page as it was left. Run against the router's
// own browser history on a jsdom window, because what is checked is what that
// history hands the browser.

import assert from 'node:assert/strict'
import { after, test } from 'node:test'

import { createBrowserHistory } from '@tanstack/react-router'
import { JSDOM } from 'jsdom'

import { leaveAppsPage } from './leave-apps-page'

const dom = new JSDOM('<!doctype html><html><body></body></html>', { url: 'http://localhost/apps' })

after(() => {
  dom.window.close()
})

function here() {
  return dom.window.location.pathname + dom.window.location.search
}

test('Back from the target lands on the Apps page with the space it was left with', async () => {
  const history = createBrowserHistory({ window: dom.window as unknown as Window & typeof globalThis })
  const entriesBefore = dom.window.history.length

  leaveAppsPage(history, '/apps?space=beta', '/space/beta/app/board')
  await Promise.resolve()

  assert.equal(here(), '/space/beta/app/board')
  assert.equal(dom.window.history.length, entriesBefore + 1)

  const popped = new Promise((resolve) => dom.window.addEventListener('popstate', resolve, { once: true }))
  dom.window.history.back()
  await popped
  assert.equal(here(), '/apps?space=beta')
  history.destroy()
})

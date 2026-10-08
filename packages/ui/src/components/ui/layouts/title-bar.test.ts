import assert from 'node:assert/strict'
import test from 'node:test'

import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'

import { TitleBar, type TitleBarProps } from './title-bar'

const noop = () => {}

function render(props: TitleBarProps): string {
  return renderToStaticMarkup(createElement(TitleBar, props))
}

// The classes of the element wrapping Back and Forward, which is where their
// visibility is decided.
function historyClasses(markup: string): string[] {
  const match = markup.match(/<div class="([^"]*)"><button[^>]*aria-label="Go back"/)
  assert.ok(match, 'Back is drawn inside its own wrapper')
  return match[1].split(/\s+/)
}

test('Back and Forward come first in the bar, before the sidebar button', () => {
  const markup = render({ onHistoryBack: noop, onHistoryForward: noop, onMenu: noop })
  const back = markup.indexOf('aria-label="Go back"')
  const forward = markup.indexOf('aria-label="Go forward"')
  const sidebar = markup.indexOf('aria-label="Open sidebar"')
  assert.ok(back !== -1 && forward !== -1 && sidebar !== -1, 'all three buttons are drawn')
  assert.ok(back < forward && forward < sidebar, 'in the order Back, Forward, sidebar')
})

test('by default Back and Forward show only in the installed-app display modes', () => {
  const classes = historyClasses(render({ onHistoryBack: noop, onHistoryForward: noop }))
  assert.ok(classes.includes('hidden'), 'hidden in a browser tab')
  assert.ok(classes.includes('[@media(display-mode:standalone)]:flex'), 'shown in standalone')
  assert.ok(classes.includes('[@media(display-mode:window-controls-overlay)]:flex'), 'shown in window-controls-overlay')
})

test('historyButtons="always" shows Back and Forward in a browser tab too', () => {
  const classes = historyClasses(render({ onHistoryBack: noop, onHistoryForward: noop, historyButtons: 'always' }))
  assert.ok(classes.includes('flex'))
  assert.ok(!classes.includes('hidden'))
})

// Whether the button carrying this label has the `disabled` attribute. The
// attribute is matched as a whole word, apart from the `disabled:` variants in
// every button's class list.
function isDisabled(markup: string, label: string): boolean {
  const match = markup.match(new RegExp(`<button[^>]*aria-label="${label}"[^>]*>`))
  assert.ok(match, `${label} is drawn`)
  return /\sdisabled(=""|\s|>)/.test(match[0])
}

test('Back and Forward are enabled unless told there is nowhere to go', () => {
  const markup = render({ onHistoryBack: noop, onHistoryForward: noop })
  assert.equal(isDisabled(markup, 'Go back'), false)
  assert.equal(isDisabled(markup, 'Go forward'), false)
})

test('canGoBack={false} disables Back and leaves Forward enabled', () => {
  const markup = render({ onHistoryBack: noop, onHistoryForward: noop, canGoBack: false })
  assert.equal(isDisabled(markup, 'Go back'), true)
  assert.equal(isDisabled(markup, 'Go forward'), false)
})

test('canGoForward={false} disables Forward and leaves Back enabled', () => {
  const markup = render({ onHistoryBack: noop, onHistoryForward: noop, canGoForward: false })
  assert.equal(isDisabled(markup, 'Go back'), false)
  assert.equal(isDisabled(markup, 'Go forward'), true)
})

test('without history callbacks the bar draws no Back or Forward', () => {
  const markup = render({ onMenu: noop })
  assert.ok(markup.includes('aria-label="Open sidebar"'), 'the bar itself rendered')
  assert.ok(!markup.includes('Go back'))
  assert.ok(!markup.includes('Go forward'))
})

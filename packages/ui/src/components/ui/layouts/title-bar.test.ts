import assert from 'node:assert/strict'
import test from 'node:test'

import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'

import { TitleBar, TitleBarIconButton, TitleBarIconLink, type TitleBarProps } from './title-bar'

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

// The opening tag of the element carrying this label.
function tagOf(markup: string, label: string): string {
  const match = markup.match(new RegExp(`<[a-z]+[^>]*aria-label="${label}"[^>]*>`))
  assert.ok(match, `${label} is drawn`)
  return match[0]
}

function classesOf(tag: string): string[] {
  const match = tag.match(/class="([^"]*)"/)
  assert.ok(match, 'the element has classes')
  return match[1].split(/\s+/).sort()
}

test('TitleBarIconLink is a link to its address, not a button, in the icon button look', () => {
  const markup = renderToStaticMarkup(
    createElement(
      'div',
      null,
      createElement(TitleBarIconLink, { href: '/inbox', 'aria-label': 'Inbox' }),
      createElement(TitleBarIconButton, { 'aria-label': 'Menu' }),
    ),
  )
  const link = tagOf(markup, 'Inbox')
  assert.ok(link.startsWith('<a '), 'an anchor')
  assert.ok(link.includes('href="/inbox"'), 'with its address')
  assert.ok(!link.includes('role='), 'with the role of a link')
  assert.deepEqual(classesOf(link), classesOf(tagOf(markup, 'Menu')))
})

test('TitleBarIconLink draws the element passed as render, keeping its address and handler', () => {
  let clicks = 0
  const onClick = () => {
    clicks++
  }
  let received: Record<string, unknown> = {}
  function RouterLink(props: Record<string, unknown>) {
    received = props
    return createElement('a', { href: props.to as string, className: props.className as string })
  }
  const markup = renderToStaticMarkup(
    createElement(TitleBarIconLink, { render: createElement(RouterLink, { to: '/inbox', onClick }) }),
  )
  assert.ok(markup.includes('href="/inbox"'), 'the router link drew the anchor')
  assert.equal(typeof received.onClick, 'function', 'the router link gets a click handler')
  ;(received.onClick as (event: unknown) => void)({ preventDefault() {}, stopPropagation() {} })
  assert.equal(clicks, 1, 'which runs the handler given with it')
  assert.ok(String(received.className).includes('size-8'), 'with the bar size')
})

test('without history callbacks the bar draws no Back or Forward', () => {
  const markup = render({ onMenu: noop })
  assert.ok(markup.includes('aria-label="Open sidebar"'), 'the bar itself rendered')
  assert.ok(!markup.includes('Go back'))
  assert.ok(!markup.includes('Go forward'))
})

// The quotation's two shapes: a label alone, wrapping, and a label with its
// place, one line that shortens to fit. Which form fits is decided by
// measurement, and a server render measures nothing, so the rule is pinned
// through its pure halves and the markup through the form a first render
// draws. Whether a narrowed quote really shortens is a browser's to see.

import assert from 'node:assert/strict'
import test from 'node:test'

import type { ReactNode } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'

import type { ChatTurnRenderers, ChatUserMessagePart, UserText } from './chat-turn'
import { ChatUserMessage } from './chat-turn'
import { quotePathForm, quotePathParts, SelectionBadge } from './selection-badge'

test('a label without a place is quoted on its own, wrapping over up to three lines', () => {
  assert.equal(
    renderToStaticMarkup(<SelectionBadge label='Selected node: agent-container' title='the whole block' />),
    '<blockquote title="the whole block" class="m-0 min-w-0 border-l-2 border-primary pl-2 text-xs text-muted-foreground line-clamp-3 break-words">Selected node: agent-container</blockquote>',
  )
})

test('an empty place is no place', () => {
  assert.equal(
    renderToStaticMarkup(<SelectionBadge label='x' place={[]} />),
    renderToStaticMarkup(<SelectionBadge label='x' />),
  )
})

test('with a place, one line: every part, the place parts apart from the label', () => {
  const html = renderToStaticMarkup(<SelectionBadge label='2 nodes selected' place={['Acme', 'Default']} />)
  assert.doesNotMatch(html, /line-clamp-3/, 'a path does not wrap')
  // The drawn form is the first child of the measured span; the unseen
  // measuring copies follow it, marked aria-hidden.
  const drawn = html.slice(0, html.indexOf('<span aria-hidden'))
  assert.deepEqual(
    [...drawn.matchAll(/<span class="([^"]*)">([^<]+)/g)].map(([, cls, text]) => [text, cls.includes('truncate')]),
    [
      ['Acme', false],
      ['Default', false],
      ['2 nodes selected', true],
    ],
  )
  assert.doesNotMatch(drawn, /title=/, 'nothing is hidden, so there is no hover hint')
})

test("a caller's title stands, whatever the form", () => {
  const html = renderToStaticMarkup(
    <SelectionBadge label='api' place={['Acme', 'Default']} title={'Acme › Default › api\nNode "api"'} />,
  )
  assert.deepEqual(
    [...html.matchAll(/title="([^"]*)"/g)].map(([, value]) => value),
    ['Acme › Default › api\nNode &quot;api&quot;'],
    'one title, the caller’s',
  )
})

test("a delivered message draws an attachment's place as the quote's path", () => {
  const renderers = {
    Chained: ({ children }: { children: ReactNode }) => <div>{children}</div>,
  } as unknown as ChatTurnRenderers
  const part: ChatUserMessagePart = {
    text: 'why?' as UserText,
    attachments: [{ label: '2 nodes selected', place: ['Acme', 'Default'], detail: 'the block' }],
  }
  const html = renderToStaticMarkup(<ChatUserMessage parts={[part]} renderers={renderers} />)
  const quote = html.match(/<blockquote[\s\S]*?<\/blockquote>/)?.[0] ?? ''
  assert.match(quote, /title="the block"/)
  assert.match(quote, />Acme<svg/)
  assert.match(quote, />Default<svg/)
  assert.match(quote, /<span class="min-w-0 truncate">2 nodes selected<\/span>/)
})

test('the longest form that fits its width is the one shown', () => {
  const widths = { full: 300, short: 200 }
  assert.equal(quotePathForm(300, widths), 'full')
  assert.equal(quotePathForm(299, widths), 'short')
  assert.equal(quotePathForm(200, widths), 'short')
  assert.equal(quotePathForm(199, widths), 'label')
})

test('each form names its parts: all of them, the first and the last, the last alone', () => {
  const place = ['Acme', 'Default']
  assert.deepEqual(quotePathParts('full', place, 'api'), ['Acme', 'Default', 'api'])
  assert.deepEqual(quotePathParts('short', place, 'api'), ['Acme', '…', 'api'])
  assert.deepEqual(quotePathParts('label', place, 'api'), ['api'])
  // One part of place has nothing to leave out.
  assert.deepEqual(quotePathParts('short', ['Acme'], 'api'), ['Acme', 'api'])
})

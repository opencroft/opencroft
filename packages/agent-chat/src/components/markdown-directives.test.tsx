import assert from 'node:assert/strict'
import test from 'node:test'

import { renderToStaticMarkup } from 'react-dom/server'

import { Markdown } from './markdown'
import { MARKDOWN_CALLOUT_KINDS } from './markdown-callout'

function render(text: string, inline = false): string {
  return renderToStaticMarkup(<Markdown text={text} inline={inline} />)
}

// Markup with the tags taken out, so an assertion about what the reader sees
// is not also an assertion about how it is wrapped.
function visibleText(html: string): string {
  return html.replace(/<[^>]*>/g, '')
}

test('each callout kind renders as a note headed by its own name', () => {
  const expected = { note: 'Note', tip: 'Tip', important: 'Important', warning: 'Warning', caution: 'Caution' }
  assert.deepEqual(MARKDOWN_CALLOUT_KINDS, Object.keys(expected))
  for (const [kind, title] of Object.entries(expected)) {
    const html = render(`:::${kind}\nBody of the ${kind}.\n:::`)
    assert.match(html, /role="note"/, kind)
    assert.equal(visibleText(html), `${title}Body of the ${kind}.`, kind)
  }
})

test('a callout title attribute replaces the kind name', () => {
  const html = render(':::warning{title="Before you upgrade"}\nBack up first.\n:::')
  assert.equal(visibleText(html), 'Before you upgradeBack up first.')
})

test('details renders a native disclosure with its summary', () => {
  const html = render(':::details{summary="Full log"}\nline one\n:::')
  assert.match(html, /^<div class="prose-chat"><details class="[^"]*">/)
  assert.match(html, /<summary[^>]*>.*<span>Full log<\/span><\/summary>/)
  assert.match(html, /line one/)
})

test('details without a summary is headed "Details"', () => {
  assert.match(render(':::details\nhidden\n:::'), /<span>Details<\/span>/)
})

test('tabs render a tab strip with one trigger per tab, the first selected', () => {
  const html = render(
    [
      '::::tabs',
      ':::tab{label="npm"}',
      '`npm install`',
      ':::',
      ':::tab{label="pnpm"}',
      '`pnpm add`',
      ':::',
      '::::',
    ].join('\n'),
  )
  const triggers = [...html.matchAll(/role="tab"[^>]*>([^<]*)</g)].map((match) => match[1])
  assert.deepEqual(triggers, ['npm', 'pnpm'])
  assert.match(html, /role="tablist"/)
  assert.match(html, /<code>npm install<\/code>/)
  assert.doesNotMatch(html, /:::/)
})

test('an unknown directive renders its content as plain content, never as raw ::: or an error', () => {
  const html = render(':::someday-block{title="Later"}\nStill **readable**.\n:::')
  assert.equal(html, '<div class="prose-chat"><div><p>Still <strong>readable</strong>.</p></div></div>')
})

test('attributes other than the one a block reads never reach the page', () => {
  const html = render(':::note{title="Hi" style="position:fixed" onclick="alert(1)" class="x"}\nbody\n:::')
  assert.doesNotMatch(html, /position:fixed|alert\(1\)|onclick|class="x"/)
  const unknown = render(':::mystery{style="position:fixed" id="spoof"}\nbody\n:::')
  assert.doesNotMatch(unknown, /position:fixed|spoof/)
})

test('a tabs block holding anything besides tabs falls back to plain content', () => {
  const html = render('::::tabs\nstray paragraph\n:::tab{label="A"}\ninside\n:::\n::::')
  assert.doesNotMatch(html, /role="tab/)
  assert.equal(visibleText(html), 'stray paragraphinside')
})

test('a tab outside tabs is plain content', () => {
  const html = render(':::tab{label="A"}\nalone\n:::')
  assert.equal(html, '<div class="prose-chat"><div><p>alone</p></div></div>')
})

test('text directives in prose stay the text the author typed', () => {
  const source = 'See file:README, set key:value{x=1} and mailto:someone :smile: today.'
  assert.equal(render(source), `<div class="prose-chat"><p>${source}</p></div>`)
})

test('a leaf directive at a line start stays the text the author typed', () => {
  assert.equal(render('::vector[int]{a=b}'), '<div class="prose-chat"><p>::vector[int]{a=b}</p></div>')
})

test('blocks nest: a callout inside a tab inside tabs', () => {
  const html = render('::::tabs\n:::tab{label="Linux"}\n\n:::::tip\nUse the package manager.\n:::::\n\n:::\n::::')
  assert.match(html, /role="tab"[^>]*>Linux</)
  assert.match(html, /role="note"/)
  assert.match(visibleText(html), /TipUse the package manager\./)
})

test('inline rendering unwraps a block to its text', () => {
  const html = render(':::note\nshort **hint**\n:::', true)
  assert.equal(html, '<span class="prose-chat">short <strong>hint</strong></span>')
})

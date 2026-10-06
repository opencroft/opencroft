import assert from 'node:assert/strict'
import test from 'node:test'

import { renderToStaticMarkup } from 'react-dom/server'
import { PALETTE_HUES, PALETTE_SHADES } from 'ui/components/ui/input/color-palette'
import { preloadIcons } from 'ui/components/ui/media/named-icon'

import { Markdown } from './markdown'
import { MARKDOWN_CALLOUT_KINDS } from './markdown-callout'
import { MARKDOWN_ICON_COLOR_CHOICES } from './markdown-icon'

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

test('a directive label is the heading when no attribute names one', () => {
  assert.equal(visibleText(render(':::note[Heads *up*]\nBody.\n:::')), 'Heads upBody.')
  assert.match(render(':::details[Full log]\nhidden\n:::'), /<span>Full log<\/span>/)
  const tabs = render('::::tabs\n:::tab[npm]\nx\n:::\n::::')
  assert.match(tabs, /role="tab"[^>]*>npm</)
})

test('the attribute wins over the label, and the label never shows in the body', () => {
  assert.equal(visibleText(render(':::tip[From label]{title="From attribute"}\nBody.\n:::')), 'From attributeBody.')
})

test('an unknown directive keeps its label as content', () => {
  assert.equal(
    render(':::someday[Later]\nBody.\n:::'),
    '<div class="prose-chat"><div><p>Later</p><p>Body.</p></div></div>',
  )
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

test('an icon renders in the line as that Lucide icon, in its theme colour', async () => {
  await preloadIcons(['rocket'])
  const html = render('Ship :icon[rocket]{color=primary} today.')
  assert.match(html, /^<div class="prose-chat"><p>Ship <svg [^>]*class="lucide lucide-rocket [^"]*text-primary"/)
  assert.match(html, /<\/svg> today\.<\/p><\/div>$/)
  assert.doesNotMatch(html, /:icon|rocket\]/)
})

test('every colour the picker offers draws with its own class', async () => {
  await preloadIcons(['star'])
  for (const { id, className } of MARKDOWN_ICON_COLOR_CHOICES) {
    assert.match(render(`:icon[star]{color=${id}}`), new RegExp(`class="lucide lucide-star [^"]*${className}"`), id)
  }
})

test('every hue of the palette at every shade draws with its own class', async () => {
  await preloadIcons(['star'])
  for (const hue of PALETTE_HUES) {
    for (const shade of PALETTE_SHADES) {
      const id = `${hue}-${shade}`
      assert.match(render(`:icon[star]{color=${id}}`), new RegExp(`class="lucide lucide-star [^"]*text-${id}"`), id)
    }
  }
})

test('an icon with no colour, or one that is neither a theme nor a palette colour, takes the text colour', async () => {
  await preloadIcons(['star'])
  for (const source of [
    ':icon[star]',
    ':icon[star]{color=teal}',
    ':icon[star]{color=teal-550}',
    ':icon[star]{color=mauve-500}',
    ':icon[star]{color="#ff0000"}',
  ]) {
    const html = render(source)
    assert.match(html, /lucide-star/, source)
    assert.doesNotMatch(html, /text-(primary|success|warning|destructive|muted-foreground)|teal|mauve|#ff0000/, source)
  }
})

test('an icon name Lucide does not have renders a neutral placeholder naming it', () => {
  const html = render(':icon[no-such-icon]{color=destructive}')
  assert.match(html, /lucide-square-dashed[^"]*text-muted-foreground/)
  assert.match(html, /<title>Unknown icon “no-such-icon”<\/title>/)
  assert.doesNotMatch(html, /text-destructive/)
})

test('attributes other than the colour never reach an icon', async () => {
  await preloadIcons(['star'])
  const html = render(':icon[star]{color=primary style="position:fixed" onclick="alert(1)" class="x"}')
  assert.doesNotMatch(html, /position:fixed|alert\(1\)|onclick|class="x"/)
})

test('an icon with no label stays the text the author typed', () => {
  assert.equal(render('Use :icon here.'), '<div class="prose-chat"><p>Use :icon here.</p></div>')
})

test('inline rendering keeps an icon', async () => {
  await preloadIcons(['star'])
  assert.match(render('a :icon[star] b', true), /^<span class="prose-chat">a <svg [^>]*lucide-star/)
})

test('inline rendering unwraps a block to its text', () => {
  const html = render(':::note\nshort **hint**\n:::', true)
  assert.equal(html, '<span class="prose-chat">short <strong>hint</strong></span>')
})

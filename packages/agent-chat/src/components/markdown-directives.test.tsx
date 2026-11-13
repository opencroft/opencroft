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

/**
 * The grid's own classes, and each grid column's span classes in source
 * order, as `col-span-12 @3xl:col-span-4`.
 */
function gridClasses(html: string): { grid: string | undefined; columns: string[] } {
  const grid = /<div class="(grid [^"]*)">/.exec(html)?.[1]
  const columns = [...html.matchAll(/<div class="(col-span-\d+ [^"]*)">/g)].map((match) =>
    match[1]
      .split(' ')
      .filter((name) => /^(@xl:|@3xl:)?col-span-\d+$/.test(name))
      .join(' '),
  )
  return { grid, columns }
}

/** A grid of `layout` whose columns hold `A`, `B`, ... in order. */
function grid(layout: string, count: number): string {
  const columns = Array.from({ length: count }, (_, k) => `:::col\n${String.fromCharCode(65 + k)}\n:::`)
  return [`::::grid{layout=${layout}}`, ...columns, '::::'].join('\n')
}

test('a grid renders its blocks on a 12-column grid, its steps measured on its container', () => {
  const html = render(grid('1/2+1/2', 2))
  assert.match(html, /<div class="@container my-2">/)
  const { grid: classes, columns } = gridClasses(html)
  assert.equal(classes, 'grid grid-cols-12 gap-4 @xl:gap-8')
  assert.deepEqual(columns, ['col-span-12 @xl:col-span-6', 'col-span-12 @xl:col-span-6'])
  assert.equal(visibleText(html), 'AB')
  assert.doesNotMatch(html, /:::/)
})

test('a third beside two thirds is 4 + 8 of 12 wide, and a full row each below that', () => {
  const { columns } = gridClasses(render(grid('1/3+2/3', 2)))
  assert.deepEqual(columns, ['col-span-12 @3xl:col-span-4', 'col-span-12 @3xl:col-span-8'])
})

test('a half beside two quarters takes a row alone below wide, and the quarters share the next as halves', () => {
  const { columns } = gridClasses(render(grid('1/2+1/4+1/4', 3)))
  assert.deepEqual(columns, ['col-span-12 @3xl:col-span-6', 'col-span-6 @3xl:col-span-3', 'col-span-6 @3xl:col-span-3'])
})

test('a full-width block spans the row at every step', () => {
  assert.deepEqual(gridClasses(render(grid('full', 1))).columns, ['col-span-12'])
})

test('the layout may be written as the label', () => {
  const html = render('::::grid[1/4+3/4]\n:::col\nA\n:::\n:::col\nB\n:::\n::::')
  assert.equal(gridClasses(html).columns.length, 2)
  assert.equal(visibleText(html), 'AB')
})

test('a column holds any markdown, and the columns keep their source order', () => {
  const html = render(
    [
      ':::::grid{layout=1/2+1/2}',
      ':::col',
      '| a | b |',
      '| - | - |',
      '| 1 | 2 |',
      ':::',
      '::::col',
      ':::tip',
      'Inside a column.',
      ':::',
      '::::',
      ':::::',
    ].join('\n'),
  )
  assert.equal(gridClasses(html).columns.length, 2)
  assert.ok(html.indexOf('<table') < html.indexOf('role="note"'))
  assert.match(visibleText(html), /TipInside a column\./)
})

test('a grid without a layout of its own, or with columns its layout does not have, is plain content', () => {
  const sources = [
    grid('1/3+2/3', 3),
    grid('1/4+1/4+1/4+1/4', 3),
    grid('1/2', 2),
    grid('2/3+2/3', 2),
    '::::grid\n:::col\nA\n:::\n:::col\nB\n:::\n::::',
  ]
  for (const source of sources) {
    const html = render(source)
    assert.equal(gridClasses(html).grid, undefined, source)
    assert.match(visibleText(html), /^AB/, source)
  }
})

test('a grid holding anything besides columns, and a column outside a grid, are plain content', () => {
  const html = render('::::grid{layout=full}\nstray paragraph\n:::col\ninside\n:::\n::::')
  assert.equal(gridClasses(html).grid, undefined)
  assert.equal(visibleText(html), 'stray paragraphinside')
  assert.equal(render(':::col\nalone\n:::'), '<div class="prose-chat"><div><p>alone</p></div></div>')
  assert.equal(render('::::grid{layout=full}\n::::'), '<div class="prose-chat"><div></div></div>')
})

test('a malformed grid written with its layout as the label keeps the label as text', () => {
  assert.equal(visibleText(render('::::grid[1/2+1/2]\n:::col\nA\n:::\n::::')), '1/2+1/2A')
})

test('attributes other than the layout never reach a grid', () => {
  const html = render(
    '::::grid{layout=full style="position:fixed"}\n:::col{onclick="alert(1)" class="x"}\nA\n:::\n::::',
  )
  assert.equal(gridClasses(html).columns.length, 1)
  assert.doesNotMatch(html, /position:fixed|alert\(1\)|onclick|class="x"|layout="/)
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

// The hinted content, as the trigger the hint opens from.
const HINT_TRIGGER = /<span [^>]*role="button"[^>]*>(.*?)<\/span>/

test('a hint marks its content, formatting, icons and emoji included, as a focusable trigger', async () => {
  await preloadIcons(['rocket'])
  const html = render('Ship :hint[**today** :icon[rocket] 🚀]{text="Before the freeze"} please.')
  const trigger = HINT_TRIGGER.exec(html)
  assert.ok(trigger, 'a trigger')
  assert.match(trigger[0], /tabindex="0"/)
  assert.match(trigger[0], /class="[^"]*border-dotted/)
  assert.match(trigger[1], /^<strong>today<\/strong> <svg [^>]*lucide-rocket.*<\/svg> 🚀$/)
  // The icon draws no text, so the spaces either side of it meet.
  assert.equal(visibleText(html), 'Ship today  🚀 please.')
  assert.doesNotMatch(html, /:hint|text=/)
})

test('a hint goes around inline code and inside bold or a link', () => {
  assert.equal(HINT_TRIGGER.exec(render('a :hint[`c`]{text=t} b'))?.[1], '<code>c</code>')
  assert.match(render('**a :hint[b]{text=t} c**'), /<strong>a <span [^>]*role="button"[^>]*>b<\/span> c<\/strong>/)
  assert.match(
    render('[a :hint[b]{text=t} c](https://example.com)'),
    /<a [^>]*href="https:\/\/example.com"[^>]*>a <span [^>]*role="button"[^>]*>b<\/span> c<\/a>/,
  )
})

test('a hint with no note, or an empty one, is its content alone', () => {
  for (const source of ['a :hint[**b**] c', 'a :hint[**b**]{text=""} c', 'a :hint[**b**]{text="  "} c']) {
    assert.equal(render(source), '<div class="prose-chat"><p>a <strong>b</strong> c</p></div>', source)
  }
})

test('attributes other than the note never reach a hint', () => {
  const html = render(':hint[b]{text=t style="position:fixed" onclick="alert(1)" class="x"}')
  assert.match(html, HINT_TRIGGER)
  assert.doesNotMatch(html, /position:fixed|alert\(1\)|onclick|class="x"/)
})

test('inline rendering keeps a hint', () => {
  assert.match(render('a :hint[b]{text=t} c', true), /^<span class="prose-chat">a <span [^>]*role="button"[^>]*>b<\/span> c/)
})

import assert from 'node:assert/strict'
import { test } from 'node:test'

import { JSDOM } from 'jsdom'
import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'

import { wordDiff } from '../tool-views/diff-view'
import { changedRanges, MarkdownDiffView } from './markdown-diff-view'

// What the renderer is handed, drawn visibly so the markup shows which block went where.
const renderBlock = (markdown: string) => createElement('p', { 'data-block': markdown }, markdown)

const view = (before: string, after: string) =>
  renderToStaticMarkup(createElement(MarkdownDiffView, { before, after, renderBlock, proseClassName: 'prose-docs' }))

test('a changed block is drawn removed in a del frame, then added in an ins frame', () => {
  const markup = view('# A\n\nOpens at eight.', '# A\n\nOpens at nine.')
  const removed = markup.indexOf('<del data-diff="removed"')
  const added = markup.indexOf('<ins data-diff="added"')
  assert.ok(removed >= 0 && added > removed, markup)
  assert.match(markup, /<del data-diff="removed"[^>]*><p data-block="Opens at eight.">/)
  assert.match(markup, /<ins data-diff="added"[^>]*><p data-block="Opens at nine.">/)
  // An unchanged block is drawn as the renderer draws it, with no frame.
  assert.match(markup, /<div class="prose-docs">(<style[^>]*>.*?<\/style>)?<p data-block="# A">/)
})

test('a changed list item is framed alone; the items around it are drawn unframed', () => {
  const markup = view('- one\n- two\n- three', '- one\n- 2\n- three')
  assert.match(markup, /<div[^>]*><p data-block="- one">- one<\/p><\/div><del data-diff="removed"[^>]*><p data-block="- two">/)
  assert.match(markup, /<ins data-diff="added"[^>]*><p data-block="- 2">- 2<\/p><\/ins><div[^>]*><p data-block="- three">/)
  assert.equal(markup.match(/data-diff=/g)?.length, 2)
})

test('the parts of a block join: no margin on the edges they share', () => {
  const markup = view('- one\n- two\n- three', '- one\n- 2\n- three')
  const classes = [...markup.matchAll(/<(?:div|del|ins)[^>]*class="([^"]*)"[^>]*><p data-block/g)].map((match) => match[1])
  const joins = classes.map((name) => [name.includes(':first-child]:mt-0'), name.includes(':last-child]:mb-0')])
  // one, two removed, two added, three: the first keeps its top margin and the last its bottom one.
  assert.deepEqual(joins, [
    [false, true],
    [true, true],
    [true, true],
    [true, false],
  ])
})

test('a nested change draws the item above it once, then the nested parts in a list of the view', () => {
  const markup = view('- fruit\n  - apples\n  - pears', '- fruit\n  - apples\n  - plums')
  assert.match(
    markup,
    /<p data-block="- fruit">- fruit<\/p><\/div><ul class="my-0 list-none"><li class="my-0"><div[^>]*><p data-block="- apples">/,
  )
  assert.equal(markup.match(/data-block="- fruit"/g)?.length, 1)
})

test('a changed code block is drawn as a line diff, not as two framed blocks', () => {
  const markup = view('```\nkeep\nold\n```', '```\nkeep\nnew\n```')
  assert.match(markup, /data-diff="code"/)
  assert.doesNotMatch(markup, /<(del|ins) data-diff/)
  assert.doesNotMatch(markup, /data-block/)
  assert.match(markup, /removed: <\/span><span[^>]*>(<span[^>]*>)?old</)
  assert.match(markup, /added: <\/span><span[^>]*>(<span[^>]*>)?new</)
})

test('two equal documents say so instead of drawing the page', () => {
  assert.match(view('Same.', 'Same.'), /No changes/)
})

test('a folded run is one row that says how many blocks it holds', () => {
  const before = ['One.', 'Two.', 'Three.', 'Four.', 'Old.'].join('\n\n')
  const markup = view(before, before.replace('Old.', 'New.'))
  assert.match(markup, /<button[^>]*>⋯ 3 unchanged blocks<\/button>/)
  assert.doesNotMatch(markup, /data-block="One\."/)
})

test('a fold opened in one diff is closed again in the next', async () => {
  const { window } = new JSDOM('<!doctype html><body></body>')
  const globals = globalThis as Record<string, unknown>
  Object.assign(globals, { window, document: window.document, IS_REACT_ACT_ENVIRONMENT: true })
  try {
    const { act } = await import('react')
    const { createRoot } = await import('react-dom/client')
    const container = window.document.createElement('div')
    const root = createRoot(container)
    const page = (last: string) => ['One.', 'Two.', 'Three.', 'Four.', last].join('\n\n')
    const show = (before: string, after: string) =>
      act(() => root.render(createElement(MarkdownDiffView, { before, after, renderBlock })))
    const foldRow = () => container.querySelector('button')

    await show(page('Old.'), page('New.'))
    await act(() => foldRow()?.click())
    assert.equal(foldRow(), null)
    // Another pair of versions with its fold at the same place, as the next
    // entry of a page's history has.
    await show(page('Older.'), page('Newer.'))
    assert.match(foldRow()?.textContent ?? '', /3 unchanged blocks/)
    await act(() => root.unmount())
  } finally {
    for (const name of ['window', 'document', 'IS_REACT_ACT_ENVIRONMENT']) {
      delete globals[name]
    }
  }
})

test("each block is drawn with its own version's link definitions", () => {
  const markup = view('Read [it][x].\n\n[x]: https://example.com/a', 'Read [it][x] now.\n\n[x]: https://example.com/b')
  assert.match(markup, /<del[^>]*><p data-block="Read \[it\]\[x\].\n\n\[x\]: https:\/\/example.com\/a">/)
  assert.match(markup, /<ins[^>]*><p data-block="Read \[it\]\[x\] now.\n\n\[x\]: https:\/\/example.com\/b">/)
})

test('the changed words become ranges over the drawn text, across formatting', () => {
  const { window } = new JSDOM('<!doctype html><body></body>')
  const frame = (html: string) => {
    const element = window.document.createElement('div')
    element.innerHTML = html
    return element
  }
  const removed = frame('<p>The orchard opens at <strong>eight</strong> and closes at dusk.</p>')
  const added = frame('<p>The orchard opens at <strong>nine</strong> sharp and closes at dusk.</p>')
  const words = wordDiff(removed.textContent ?? '', added.textContent ?? '', 1_000)
  assert.ok(words)
  assert.deepEqual(
    changedRanges(removed, words.removed).map((range) => range.toString()),
    ['eight'],
  )
  // "nine sharp" runs out of the bold word into the text after it: one range
  // over two text nodes.
  const [range, ...rest] = changedRanges(added, words.added)
  assert.equal(range.toString(), 'nine sharp')
  assert.notEqual(range.startContainer, range.endContainer)
  assert.equal(rest.length, 0)
})

test('a changed span of only whitespace is not marked', () => {
  const { window } = new JSDOM('<!doctype html><body><p id="p">a  b</p></body>')
  const root = window.document.getElementById('p') as HTMLElement
  const ranges = changedRanges(root, [
    { text: 'a', changed: false },
    { text: '  ', changed: true },
    { text: 'b', changed: true },
  ])
  assert.deepEqual(
    ranges.map((range) => range.toString()),
    ['b'],
  )
})

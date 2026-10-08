import assert from 'node:assert/strict'
import { test } from 'node:test'

import { JSDOM } from 'jsdom'
import { createElement, type ReactNode } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'

import { wordDiff } from '../tool-views/diff-view'
import { changedRanges, MarkdownDiffView, runsByLine, wordText } from './markdown-diff-view'

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

// For each part's wrapper, whether it drops its top and its bottom margin.
const partJoins = (markup: string) =>
  [...markup.matchAll(/<(?:div|del|ins)[^>]*class="([^"]*)"[^>]*><p data-block/g)].map((match) => [
    match[1].includes(':first-child]:mt-0'),
    match[1].includes(':last-child]:mb-0'),
  ])

test('the lines of a paragraph join: no margin on the edges they share', () => {
  const markup = view('Opens at eight\\\nCloses at dusk\\\nNo dogs', 'Opens at eight\\\nCloses at six\\\nNo dogs')
  // eight, dusk removed, six added, dogs: the first keeps its top margin and the last its bottom one.
  assert.deepEqual(partJoins(markup), [
    [false, true],
    [true, true],
    [true, true],
    [true, false],
  ])
})

test("a list's parts join on every edge, in one block with the list's margins", () => {
  // The prose may hold a list's items' outer margins inside the list, as it
  // lets the list scroll; the block is where the list is, so it does the same.
  const markup = view('- one\n- two\n- three', '- one\n- 2\n- three')
  assert.match(markup, /<div class="-mx-3 my-\[var\(--prose-list-space\)\] px-3"><div[^>]*><p data-block="- one">/)
  assert.deepEqual(partJoins(markup), [
    [true, true],
    [true, true],
    [true, true],
    [true, true],
  ])
})

test('every part lets its margins out, framed or not, so they meet the next part as in one list', () => {
  // A prose may make its children scroll, which keeps their margins inside them.
  const markup = view('- fruit\n  - apples\n  - pears\n- nuts\n- figs', '- fruit\n  - apples\n  - plums\n- nuts\n- dates').replace(
    /^(<style[^>]*>.*?<\/style>)?<div class="prose-docs"><div class="-mx-3 my-\[var\(--prose-list-space\)\] px-3">/,
    '',
  )
  const parts = [...markup.matchAll(/<(div|del|ins|ul)[^>]*class="([^"]*)"[^>]*>(?:<li[^>]*>)?(?:<div[^>]*>)?<p data-block="([^"]*)"/g)]
  assert.deepEqual(
    parts.map((match) => [match[1], match[3]]),
    [
      ['div', '- fruit'],
      ['ul', '- apples'],
      ['del', '- pears'],
      ['ins', '- plums'],
      ['div', '- nuts'],
      ['del', '- figs'],
      ['ins', '- dates'],
    ],
  )
  for (const [, element, classes, block] of parts) {
    assert.ok(classes.split(' ').includes('overflow-visible'), `${element} around ${block}: ${classes}`)
  }
})

test('a nested change draws the item above it once, then the nested parts in a list of the view', () => {
  const markup = view('- fruit\n  - apples\n  - pears', '- fruit\n  - apples\n  - plums')
  assert.match(
    markup,
    /<p data-block="- fruit">- fruit<\/p><\/div><ul class="my-\[var\(--prose-nested-list-space\)\] list-none overflow-visible"><li class="my-0"><div[^>]*><p data-block="- apples">/,
  )
  assert.equal(markup.match(/data-block="- fruit"/g)?.length, 1)
})

test("a nested run stands from the item above as the page's nested list, and from the next item as the item does", () => {
  // The parts inside the view's nested list, each as [element, classes, block].
  const nestedParts = (markup: string) =>
    [
      ...(markup.split('<li class="my-0">')[1]?.split('</li></ul>')[0] ?? '').matchAll(
        /<(div|del|ins)[^>]*class="([^"]*)"[^>]*><p data-block="([^"]*)"/g,
      ),
    ].map(([, element, classes, block]) => [element, classes.replaceAll('&amp;', '&').replaceAll('&gt;', '>').split(' '), block] as const)
  const followed = nestedParts(view('- fruit\n  - apples\n  - pears\n- nuts', '- fruit\n  - plums\n  - pears\n- nuts'))
  assert.deepEqual(
    followed.map(([element, , block]) => [element, block]),
    [
      ['del', '- apples'],
      ['ins', '- plums'],
      ['div', '- pears'],
    ],
  )
  assert.ok(followed[0][1].includes('[&>:first-child]:mt-0'), followed[0][1].join(' '))
  assert.ok(followed[2][1].includes('[&>:last-child]:mb-0'), followed[2][1].join(' '))

  // Last in its list, the run leaves the margin that ends the list to the list's block.
  const last = nestedParts(view('- nuts\n- fruit\n  - apples\n  - pears', '- nuts\n- fruit\n  - apples\n  - plums'))
  assert.deepEqual(
    last.map(([element, , block]) => [element, block]),
    [
      ['div', '- apples'],
      ['del', '- pears'],
      ['ins', '- plums'],
    ],
  )
  assert.ok(last[0][1].includes('[&>:first-child]:mt-0'), last[0][1].join(' '))
  assert.ok(last[2][1].includes('[&>:last-child]:mb-0'), last[2][1].join(' '))
})

test('a changed code block is drawn as a line diff, not as two framed blocks', () => {
  const markup = view('```\nkeep\nold\n```', '```\nkeep\nnew\n```')
  assert.match(markup, /data-diff="code"/)
  assert.doesNotMatch(markup, /<(del|ins) data-diff/)
  assert.doesNotMatch(markup, /data-block/)
  assert.match(markup, /removed: <\/span><span[^>]*>(<span[^>]*>)?old</)
  assert.match(markup, /added: <\/span><span[^>]*>(<span[^>]*>)?new</)
})

test('a code block whose language changed is one line diff, headed by the change of its language', () => {
  const markup = view('```yaml\nclosing: 19:00\n```', '```json\n{ "closing": "20:00" }\n```')
  assert.match(
    markup,
    /data-diff="code"[^>]*><div data-code-label=""[^>]*><span data-diff="fence"[^>]*><del[^>]*>yaml<\/del><span[^>]*>→<\/span><ins[^>]*>json<\/ins><\/span><\/div>/,
  )
  assert.doesNotMatch(markup, /data-diff="(removed|added)"/)
  assert.match(markup, /removed: <\/span><span[^>]*>(<span[^>]*>)?closing/)

  const relabelled = view('```\nplain\nsecond\nthird\nfourth\nfifth\n```', '```sh\nplain\nsecond\nthird\nfourth\nfifth\n```')
  assert.match(relabelled, /<del[^>]*>no language<\/del>.*<ins[^>]*>sh<\/ins>/)
  // Code that did not change under a changed fence is shown, every line of it
  // and none folded, as unchanged rows.
  assert.doesNotMatch(relabelled, /Code unchanged|unchanged lines|No changes/)
  assert.deepEqual(
    [...relabelled.matchAll(/<span class="sr-only"><\/span><span[^>]*>([^<]*)<\/span>/g)].map((row) => row[1]),
    ['plain', 'second', 'third', 'fourth', 'fifth'],
  )
})

test('a code diff under an unchanged fence is labelled with its language as a code block is, and one naming none is not', () => {
  const named = view('```ts {1}\nold\n```', '```ts {1}\nnew\n```')
  assert.match(named, /data-code-frame=""[^>]*data-diff="code"[^>]*><div data-code-label=""[^>]*>ts<\/div>/)
  assert.doesNotMatch(named, /data-diff="fence"/)

  const unnamed = view('```\nold\n```', '```\nnew\n```')
  assert.match(unnamed, /data-code-frame=""/)
  assert.doesNotMatch(unnamed, /data-code-label/)
})

test('a code diff is lettered as the prose letters a code block', () => {
  const markup = view('```ts\nold\n```', '```ts\nnew\n```')
  assert.match(
    markup,
    /data-diff="code"[^>]*>.*text-\[length:calc\(0\.85\*var\(--prose-pre-code-size,1em\)\)\] leading-\[var\(--prose-pre-code-line-height,1\.5\)\]/,
  )
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

test('a pair marks the words it changed, all of each version when it shares none or is past comparing', async () => {
  const { window } = new JSDOM('<!doctype html><body></body>')
  // A highlight registry as the browser keeps one: named sets of ranges.
  class Highlight extends Set<Range> {}
  const highlights = new Map<string, Highlight>()
  const globals = globalThis as Record<string, unknown>
  Object.assign(globals, {
    window,
    document: window.document,
    MutationObserver: window.MutationObserver,
    Highlight,
    CSS: { highlights },
    IS_REACT_ACT_ENVIRONMENT: true,
  })
  try {
    const { act } = await import('react')
    const { createRoot } = await import('react-dom/client')
    const root = createRoot(window.document.createElement('div'))
    const marked = async (before: string, after: string, draw: (markdown: string) => ReactNode = renderBlock) => {
      await act(() => root.render(createElement(MarkdownDiffView, { before, after, renderBlock: draw })))
      return Object.fromEntries([...highlights].map(([name, ranges]) => [name, [...ranges].map((range) => range.toString())]))
    }
    assert.deepEqual(await marked('- Pick from the lower branches', '- Pick from any branch'), {
      'markdown-diff-removed': ['the lower branches'],
      'markdown-diff-added': ['any branch'],
    })
    assert.deepEqual(await marked('Opens early.', 'Closed today!'), {
      'markdown-diff-removed': ['Opens early.'],
      'markdown-diff-added': ['Closed today!'],
    })
    // More differing words than the search follows: a rewrite, shared words
    // and all.
    const words = (from: number) => Array.from({ length: 60 }, (_, index) => `w${from + index}`).join(' ')
    const farBefore = `Keep ${words(0)}.`
    const farAfter = `Keep ${words(100)}.`
    assert.deepEqual(await marked(farBefore, farAfter), {
      'markdown-diff-removed': [farBefore],
      'markdown-diff-added': [farAfter],
    })
    // Longer than a block is compared word by word: also a rewrite.
    const longBefore = `Keep ${'a'.repeat(20_000)}`
    const longAfter = `Keep ${'b'.repeat(20_000)}`
    assert.deepEqual(await marked(longBefore, longAfter), {
      'markdown-diff-removed': [longBefore],
      'markdown-diff-added': [longAfter],
    })
    // A diagram is drawn as a picture, with styles and labels as svg text:
    // not words, so neither version is marked.
    const diagram = (edge: string) => `\`\`\`mermaid\ngraph TD\n  ${edge}\n\`\`\``
    const drawDiagrams = (markdown: string) => {
      const edge = /^```mermaid\ngraph TD\n {2}(.*)\n```$/.exec(markdown)
      return edge
        ? createElement('svg', null, createElement('style', null, '.node{fill:#eee}'), createElement('text', null, edge[1]))
        : renderBlock(markdown)
    }
    assert.deepEqual(await marked(diagram('Gate --> Barn'), diagram('Gate --> Shed'), drawDiagrams), {
      'markdown-diff-removed': [],
      'markdown-diff-added': [],
    })
    await act(() => root.unmount())
  } finally {
    for (const name of ['window', 'document', 'MutationObserver', 'Highlight', 'CSS', 'IS_REACT_ACT_ENVIRONMENT']) {
      delete globals[name]
    }
  }
})

// A stand-in highlighter: each line one run, coloured with the language it was
// asked for.
const colourLines = (code: string, info: string) => {
  const runs: { start: number; end: number; style: string }[] = []
  let at = 0
  for (const line of code.split('\n')) {
    if (line) {
      runs.push({ start: at, end: at + line.length, style: `--shiki-light:${info}` })
    }
    at += line.length + 1
  }
  return runs
}

// The rows of a code diff, the box's last child under the fence header: each
// row's sign and its coloured pieces as `text=colour`.
const codeRows = (host: Element) =>
  [...host.querySelectorAll('[data-diff="code"] > :last-child > div')].map((row) => [
    row.querySelector('.sr-only')?.textContent,
    [...row.querySelectorAll('.shiki-token')].map((piece) => `${piece.textContent}=${(piece as HTMLElement).style.getPropertyValue('--shiki-light')}`),
  ])

test('a code diff colours removed lines in the earlier language, and added and unchanged ones in the later', async () => {
  const { window } = new JSDOM('<!doctype html><body></body>')
  const globals = globalThis as Record<string, unknown>
  Object.assign(globals, { window, document: window.document, IS_REACT_ACT_ENVIRONMENT: true })
  try {
    const { act } = await import('react')
    const { createRoot } = await import('react-dom/client')
    const host = window.document.createElement('div')
    const root = createRoot(host)
    await act(async () =>
      root.render(
        createElement(MarkdownDiffView, {
          before: '```yaml\nkeep: 1\nold: 2\n```',
          after: '```json\nkeep: 1\nnew: 3\n```',
          renderBlock,
          highlightCode: async (code: string, info: string) => colourLines(code, info),
        }),
      ),
    )
    assert.deepEqual(codeRows(host), [
      ['', ['keep: 1=json']],
      // The word marks cut a coloured line into pieces; each keeps its colour.
      ['removed: ', ['old=yaml', ': =yaml', '2=yaml']],
      ['added: ', ['new=json', ': =json', '3=json']],
    ])
    await act(() => root.unmount())
  } finally {
    for (const name of ['window', 'document', 'IS_REACT_ACT_ENVIRONMENT']) {
      delete globals[name]
    }
  }
})

test('an edit keeps the colours of the lines it did not touch until its own colours arrive', async () => {
  const { window } = new JSDOM('<!doctype html><body></body>')
  const globals = globalThis as Record<string, unknown>
  Object.assign(globals, { window, document: window.document, IS_REACT_ACT_ENVIRONMENT: true })
  try {
    const { act } = await import('react')
    const { createRoot } = await import('react-dom/client')
    const host = window.document.createElement('div')
    const root = createRoot(host)
    // Colours at once until `holding`, then only when the held answers are released.
    let holding = false
    const held: (() => void)[] = []
    const highlightCode = (code: string, info: string) =>
      holding
        ? new Promise<ReturnType<typeof colourLines>>((resolve) => held.push(() => resolve(colourLines(code, info))))
        : Promise.resolve(colourLines(code, info))
    const show = (after: string) =>
      act(async () =>
        root.render(
          createElement(MarkdownDiffView, { before: '```yaml\nkeep: 1\nold: 2\n```', after, renderBlock, highlightCode }),
        ),
      )
    await show('```yaml\nkeep: 1\nnew: 3\n```')
    holding = true
    await show('```yaml\nkeep: 1\nnew: 4\n```')
    assert.equal(held.length, 2)
    assert.deepEqual(codeRows(host), [
      ['', ['keep: 1=yaml']],
      ['removed: ', ['old=yaml', ': =yaml', '2=yaml']],
      // The edited line has no colours yet: the ones before were another line's.
      ['added: ', []],
    ])
    await act(async () => {
      for (const release of held) {
        release()
      }
    })
    assert.deepEqual(codeRows(host), [
      ['', ['keep: 1=yaml']],
      ['removed: ', ['old=yaml', ': =yaml', '2=yaml']],
      ['added: ', ['new=yaml', ': =yaml', '4=yaml']],
    ])
    await act(() => root.unmount())
  } finally {
    for (const name of ['window', 'document', 'IS_REACT_ACT_ENVIRONMENT']) {
      delete globals[name]
    }
  }
})

test("a long code block's colours each land on their own line", () => {
  // Lines of a key and a value, every fifth blank, and a newline at the end.
  const lines = Array.from({ length: 20_000 }, (_, index) => (index % 5 === 4 ? '' : `key${index}: ${index}`))
  const runs: { start: number; end: number; style: string }[] = []
  const expected: { start: number; end: number; style: string }[][] = []
  let at = 0
  for (const line of [...lines, '']) {
    const own: { start: number; end: number; style: string }[] = []
    if (line) {
      const colon = line.indexOf(':')
      runs.push({ start: at, end: at + colon, style: 'key' }, { start: at + colon + 2, end: at + line.length, style: 'value' })
      own.push({ start: 0, end: colon, style: 'key' }, { start: colon + 2, end: line.length, style: 'value' })
    }
    expected.push(own)
    at += line.length + 1
  }
  // Line by line, so a failure names its line instead of diffing the block.
  const byLine = runsByLine(`${lines.join('\n')}\n`, runs)
  assert.equal(byLine.length, expected.length)
  for (const [index, own] of expected.entries()) {
    assert.deepEqual(byLine[index], own, `line ${index}`)
  }
})

test('a picture inside a block is not words: a span either side of it is a range on each side', () => {
  const { window } = new JSDOM('<!doctype html><body></body>')
  const root = window.document.createElement('div')
  root.innerHTML = '<p>Gate plan <svg><style>.node{fill:#eee}</style><text>Barn</text></svg> drawn today.</p>'
  assert.equal(wordText(root), 'Gate plan  drawn today.')
  assert.deepEqual(
    changedRanges(root, [{ text: wordText(root), changed: true }]).map((range) => range.toString()),
    ['Gate plan ', ' drawn today.'],
  )
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

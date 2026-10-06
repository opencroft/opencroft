import assert from 'node:assert/strict'
import { afterEach, test } from 'node:test'

import { renderToStaticMarkup } from 'react-dom/server'

import { Markdown } from './markdown'
import {
  findReferences,
  type InlineReference,
  installMarkdownReferences,
  type ReferenceRecogniser,
} from './markdown-references'

const RECOGNISERS: ReferenceRecogniser[] = [
  { kind: 'ticket', match: 'text', pattern: /\b(?:ABC|XY)-[1-9]\d*\b/ },
  { kind: 'page', match: 'url', pattern: 'https://app\\.example\\.com/.*' },
]

const rendered: InlineReference[] = []

function install(recognisers = RECOGNISERS) {
  installMarkdownReferences({
    recognisers,
    render: (reference) => {
      rendered.push(reference)
      return <b data-ref={reference.kind}>{reference.id}</b>
    },
  })
}

function render(text: string, inline = false): string {
  return renderToStaticMarkup(<Markdown text={text} inline={inline} />)
}

afterEach(() => {
  installMarkdownReferences(null)
  rendered.length = 0
})

// Text no recogniser claims has to come out byte-identical to the renderer
// without references at all: the same fixtures rendered with nothing
// installed, then with recognisers that claim none of them.
const UNCLAIMED = [
  'Plain paragraph with **bold**, _em_ and `code`.',
  'UTF-8, SHA-256, GPT-4 and ISO-8601 are not tickets.',
  'Paths: components/terminal, app/route-handler, lib/terminal-utils, ./src/a/terminal.',
  'A URL path https://example.com/x/terminal and www.example.org/route-1.',
  '- list\n- items ABCD-1 and ZABC-12\n\n> quote XY-0',
  '```\nABC-1 in a fence\n```',
  'Inline `ABC-12` stays code.',
  '[ABC-1](https://elsewhere.test/ABC-1) is a labelled link.',
  '[labelled](https://app.example.com/labelled) keeps its label.',
  ':::note\nA note with no ids.\n:::',
  '| a | b |\n|---|---|\n| 1 | 2 |',
]

test('text no recogniser claims renders exactly as it does with nothing installed', () => {
  const before = UNCLAIMED.map((text) => [render(text), render(text, true)])
  install()
  const after = UNCLAIMED.map((text) => [render(text), render(text, true)])
  assert.deepEqual(after, before)
  assert.deepEqual(rendered, [])
})

test('text that names an Object.prototype member renders as plain text', () => {
  const words = ['constructor', '__proto__', 'hasOwnProperty', 'toString']
  const texts = words.flatMap((word) => [word, `- ${word}`, `| h |\n|---|\n| ${word} |`])
  const before = texts.map((text) => render(text))
  install()
  assert.deepEqual(
    texts.map((text) => render(text)),
    before,
  )
  for (const word of words) {
    assert.deepEqual(findReferences(word, RECOGNISERS), [])
  }
  assert.deepEqual(rendered, [])
})

test('an installed source with no recognisers changes nothing', () => {
  const before = render('ABC-1 here')
  install([])
  assert.equal(render('ABC-1 here'), before)
})

test('identifiers in prose, lists, emphasis and tables become references', () => {
  install()
  const html = render('See ABC-1 and *XY-22*.\n\n- ABC-3\n\n| k |\n|---|\n| XY-4 |')
  assert.deepEqual(
    rendered.map((reference) => reference.id),
    ['ABC-1', 'XY-22', 'ABC-3', 'XY-4'],
  )
  assert.match(
    html,
    /See <span data-selection-text="ABC-1"><b data-ref="ticket">ABC-1<\/b><\/span> and <em><span data-selection-text="XY-22"><b data-ref="ticket">XY-22<\/b><\/span><\/em>\./,
  )
})

test('a reference is selected as the text it was written as', () => {
  install()
  const html = render('Open https://app.example.com/tasks/1 for ABC-7.')
  assert.match(html, /<span data-selection-text="https:\/\/app\.example\.com\/tasks\/1"><b data-ref="page">/)
  assert.match(html, /<span data-selection-text="ABC-7"><b data-ref="ticket">ABC-7<\/b><\/span>/)
})

test('code, inline code and labelled links are never claimed', () => {
  install()
  render('`ABC-1`\n\n```\nABC-2\n```\n\n[ABC-3](https://x.test)')
  assert.deepEqual(rendered, [])
})

test('a bare link is claimed by a url recogniser; its label-bearing twin is not', () => {
  install()
  const html = render('Open https://app.example.com/tasks/1 or [this](https://app.example.com/tasks/2).')
  assert.deepEqual(rendered, [{ kind: 'page', id: 'https://app.example.com/tasks/1', trailing: false }])
  assert.match(html, /<a href="https:\/\/app\.example\.com\/tasks\/2"[^>]*>this<\/a>/)
})

test('a url recogniser is tested against the whole address', () => {
  install()
  render('https://app.example.com.evil.test/x')
  assert.deepEqual(rendered, [])
})

test('only a match that ends the text is trailing', () => {
  install()
  render('ABC-1 then ABC-2')
  assert.deepEqual(
    rendered.map((reference) => [reference.id, reference.trailing]),
    [
      ['ABC-1', false],
      ['ABC-2', true],
    ],
  )
  rendered.length = 0
  render('ABC-2.\n')
  assert.deepEqual(rendered[0].trailing, false)
})

test('inline rendering keeps references', () => {
  install()
  assert.equal(
    render('Fix ABC-9', true),
    '<span class="prose-chat">Fix <span data-selection-text="ABC-9"><b data-ref="ticket">ABC-9</b></span></span>',
  )
})

test('findReferences folds every text recogniser into one scan, in order', () => {
  const recognisers: ReferenceRecogniser[] = [
    { kind: 'a', match: 'text', pattern: 'foo-\\d+' },
    { kind: 'b', match: 'text', pattern: /bar(?:baz)?/ },
  ]
  assert.deepEqual(findReferences('x foo-1 barbaz foo-22', recognisers), [
    { kind: 'a', id: 'foo-1', start: 2, end: 7 },
    { kind: 'b', id: 'barbaz', start: 8, end: 14 },
    { kind: 'a', id: 'foo-22', start: 15, end: 21 },
  ])
  assert.deepEqual(findReferences('nothing', recognisers), [])
})

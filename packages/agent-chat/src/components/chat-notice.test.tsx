import assert from 'node:assert/strict'
import test from 'node:test'

import { renderToStaticMarkup } from 'react-dom/server'

import { ChatNotice } from './chat-turn'
import { type MarkdownCalloutKind, markdownCalloutKind } from './markdown-callout'

// A notice draws as the callout for its severity. The callout names its kind
// nowhere in the markup, so the kind is read back from the one thing that
// differs per kind and is not a class name: its icon.
function iconOf(markup: string): string {
  const match = markup.match(/lucide-([a-z-]+)/)
  assert.ok(match, `no icon in ${markup}`)
  return match[1]
}

function kindIcon(kind: MarkdownCalloutKind): string {
  const Icon = markdownCalloutKind(kind).icon
  return iconOf(renderToStaticMarkup(<Icon />))
}

function render(severity: string, description?: string): string {
  return renderToStaticMarkup(
    <ChatNotice
      item={{ kind: 'notice', severity, title: 'Model fallback', ...(description ? { description } : {}) }}
    />,
  )
}

test('info draws as a note, warning as a warning, error as a caution', () => {
  assert.deepEqual(
    ['info', 'warning', 'error'].map((severity) => iconOf(render(severity))),
    [kindIcon('note'), kindIcon('warning'), kindIcon('caution')],
  )
  assert.match(render('warning'), /Model fallback/)
})

test('a severity the protocol does not define draws as info, including one named like an object key', () => {
  assert.equal(iconOf(render('critical')), kindIcon('note'))
  assert.equal(iconOf(render('constructor')), kindIcon('note'))
})

test('the description is shown as plain text, not as markdown', () => {
  const markup = render('info', '**not bold**')
  assert.match(markup, /\*\*not bold\*\*/)
  assert.doesNotMatch(markup, /<strong>/)
})

// The callout's heading line is the one `font-medium` row; its text is the
// heading the reader sees first.
function headingOf(markup: string): string {
  const match = markup.match(/font-medium[^>]*>.*?<span[^>]*>([^<]*)<\/span>/)
  assert.ok(match, `no heading in ${markup}`)
  return match[1]
}

test('a notice is headed by its severity, and says what happened beneath the heading', () => {
  assert.deepEqual(
    ['info', 'warning', 'error', 'critical', 'constructor'].map((severity) => headingOf(render(severity))),
    ['Info', 'Warning', 'Error', 'Info', 'Info'],
  )
  const said = 'This agent has no terminal to run through: choose a terminal in its profile.'
  const markup = renderToStaticMarkup(
    <ChatNotice
      item={{ kind: 'notice', severity: 'error', title: said, description: 'Try again.', details: 'exit code 127' }}
    />,
  )
  const heading = markup.indexOf('>Error<')
  const title = markup.indexOf(said)
  const description = markup.indexOf('Try again.')
  const details = markup.indexOf('Details')
  assert.ok(heading >= 0 && heading < title, 'the heading comes first')
  assert.ok(title < description && description < details, 'then what happened, what to do, and Details')
  assert.notEqual(headingOf(markup), said, 'what happened is not the heading')
})

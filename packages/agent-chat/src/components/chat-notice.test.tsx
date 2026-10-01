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

test('info draws as a note, warning as a warning, error as a caution, headed by the title', () => {
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

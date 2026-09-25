// What the ask-user form puts on the page for agent-written text. Every piece
// of it -- the question, a field's hint, an option's hint -- is markdown, and
// the links in it are how a reader gets from the question to what it is about.
// Rendered as plain strings they were literal brackets and parentheses.

import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import test from 'node:test'

import type { ElicitationSchema } from 'agent-client/types'
import { renderToStaticMarkup } from 'react-dom/server'

import { AskUser } from './ask-user'
import { Markdown } from './markdown'

const noop = () => {}

function render(message: string | undefined, schema: ElicitationSchema): string {
  return renderToStaticMarkup(<AskUser message={message} schema={schema} onSubmit={noop} />)
}

const oneSelect = (description?: string, optionDescription?: string): ElicitationSchema =>
  ({
    type: 'object',
    properties: {
      pick: {
        type: 'string',
        title: 'Pick',
        ...(description ? { description } : {}),
        oneOf: [{ const: 'a', title: 'Option A', ...(optionDescription ? { description: optionDescription } : {}) }],
      },
    },
  }) as ElicitationSchema

// The <label> an option's hint sits in, isolated so assertions about it cannot
// be satisfied by markup elsewhere in the form.
function optionLabel(html: string): string {
  const match = html.match(/<label[^>]*>[\s\S]*?<\/label>/)
  assert.ok(match, 'the option label renders')
  return match[0]
}

test('a link in the question renders as a link that opens in a new tab', () => {
  const html = render('Approve [the ticket](https://example.com/wp/1)?', oneSelect())
  assert.match(
    html,
    /<a href="https:\/\/example\.com\/wp\/1" target="_blank" rel="noopener noreferrer">the ticket<\/a>/,
  )
  assert.doesNotMatch(html, /\[the ticket\]/)
})

test('a plain-text question renders as its text, in the header type it always had', () => {
  const html = render('Ship it?', oneSelect())
  assert.match(
    html,
    /<div class="min-w-0 flex-1 text-sm font-medium wrap-break-word"><div class="prose-chat prose-chat-inherit"><p>Ship it\?<\/p><\/div><\/div>/,
  )
})

test('a field hint renders markdown and keeps its muted small type', () => {
  const html = render(undefined, oneSelect('See **this** [doc](https://example.com/doc)'))
  assert.match(
    html,
    /<div class="text-sm text-muted-foreground"><div class="prose-chat prose-chat-inherit"><p>See <strong>this<\/strong> <a href="https:\/\/example\.com\/doc"/,
  )
})

test('an option hint renders inline inside the label, link included, in the hint type', () => {
  const label = optionLabel(render(undefined, oneSelect(undefined, 'per [the spec](https://example.com/spec)')))
  assert.match(
    label,
    /<span class="ml-1 text-xs text-muted-foreground"><span class="prose-chat prose-chat-inherit">per <a href="https:\/\/example\.com\/spec"/,
  )
  // A label holds phrasing content only: no paragraph, no div, no list.
  assert.doesNotMatch(label, /<(p|div|ul|ol|h\d)[\s>]/)
})

test('inline markdown unwraps block constructs to their text instead of dropping it', () => {
  const html = renderToStaticMarkup(<Markdown text={'# Heading\n\n- item one\n- item two'} inline />)
  assert.match(html, /^<span class="prose-chat">/)
  assert.match(html, /Heading/)
  assert.match(html, /item one/)
  assert.match(html, /item two/)
  assert.doesNotMatch(html, /<(p|h1|ul|li)[\s>]/)
})

test('the default rendering is unchanged: chat typography in a div', () => {
  const html = renderToStaticMarkup(<Markdown text='hello' />)
  assert.equal(html, '<div class="prose-chat"><p>hello</p></div>')
})

test('the inherit typography class has a rule that defers the base type', () => {
  const css = readFileSync(new URL('../styles.css', import.meta.url), 'utf8')
  const rule = css.match(/\.prose-chat\.prose-chat-inherit\s*\{([^}]*)\}/)
  assert.ok(rule, 'styles.css defines .prose-chat.prose-chat-inherit')
  for (const property of ['color', 'font-size', 'line-height']) {
    assert.match(rule[1], new RegExp(`${property}:\\s*inherit`))
  }
})

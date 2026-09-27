// What Reply leaves in the composer. Each case asserts the whole resulting
// text, because the requirement is about its exact shape: one empty line
// before the quotation, one after it, and the caret's line last.

import assert from 'node:assert/strict'
import test from 'node:test'

import { appendQuotedReply, quoteMarkdown } from './message-quote'

test('an empty composer gets the quotation and the empty line that ends it', () => {
  assert.equal(appendQuotedReply('', 'the quoted text'), '> the quoted text\n\n')
})

test('a composer holding only whitespace counts as empty', () => {
  assert.equal(appendQuotedReply('  \n\n', 'the quoted text'), '> the quoted text\n\n')
})

test('existing text is kept, then one empty line, then the quotation', () => {
  // A worked example: the caret goes at the end, which is the
  // empty line after the one that ends the quotation.
  assert.equal(
    appendQuotedReply('some existing text in the input field', 'the quoted text'),
    'some existing text in the input field\n\n> the quoted text\n\n',
  )
})

test('trailing whitespace in the composer does not widen the gap before the quotation', () => {
  assert.equal(appendQuotedReply('draft\n\n\n  ', 'quoted'), 'draft\n\n> quoted\n\n')
})

test('a second reply stacks below the first with the same single gaps', () => {
  const once = appendQuotedReply('', 'first')
  assert.equal(appendQuotedReply(once, 'second'), '> first\n\n> second\n\n')
})

test('every line is quoted, and an empty line inside the text becomes a bare marker', () => {
  assert.equal(quoteMarkdown('one\ntwo\n\nthree'), '> one\n> two\n>\n> three')
  assert.equal(appendQuotedReply('draft', 'one\ntwo\n\nthree'), 'draft\n\n> one\n> two\n>\n> three\n\n')
})

test('a whitespace-only line inside the text is an empty line too', () => {
  assert.equal(quoteMarkdown('one\n   \ntwo'), '> one\n>\n> two')
})

test('line breaks around the text are dropped, so the quotation neither opens nor closes on a bare marker', () => {
  // A selection that runs to the end of a paragraph carries its break.
  assert.equal(quoteMarkdown('\n\nfirst paragraph\n\nsecond\n\n'), '> first paragraph\n>\n> second')
})

test('indentation inside a line is kept', () => {
  assert.equal(quoteMarkdown('- item\n  - nested'), '> - item\n>   - nested')
})

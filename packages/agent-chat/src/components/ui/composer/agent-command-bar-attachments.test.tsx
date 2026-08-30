// The attachments row: whether it is there, and where.
//
// Both halves of this have already been got wrong once each in this composer,
// which is why they are pinned against the real markup rather than described:
//
//   * the chip shipped INSIDE the action row, because the host handed it to a
//     slot that renders there. Type-correct, green everywhere, and visible
//     only to somebody looking at the screen -- which on this side is nobody;
//   * a row that renders whether or not it holds anything costs every composer
//     a strip of empty height, and an empty element is exactly as invisible to
//     a typecheck as a full one.
//
// The sibling `.test.ts` file covers the exported constants and the buffer
// rule, which are pure. These need markup, hence a second file.

import assert from 'node:assert/strict'
import test from 'node:test'

import type { ReactNode } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'

import { AgentCommandBar } from './agent-command-bar'

// A literal rather than an element: what is being located is the row around
// the slot's content, so the content itself should add no elements to count.
const ATTACHED = '[[attached]]'

function render(attachments?: ReactNode): string {
  return renderToStaticMarkup(
    <AgentCommandBar value='' onValueChange={() => {}} onSend={() => {}} attachments={attachments} />,
  )
}

// The wrapper the row draws around whatever it is given. Matched from the
// content outwards rather than by its classes, so this says "the element
// enclosing the slot" and keeps saying it when the styling changes.
const ROW = /<div class="[^"]*">\[\[attached\]\]<\/div>/

test('given nothing, the row is absent rather than empty', () => {
  const empty = render()
  const filled = render(ATTACHED)
  const row = filled.match(ROW)
  assert.ok(row, `no single element found around the slot content in:\n${filled}`)

  // The whole assertion. Deleting the row from the filled markup reproduces
  // the empty markup EXACTLY -- so the empty case carries no element for the
  // row at all, not one that happens to have nothing in it. An always-present
  // wrapper would leave its own tags behind here and fail this, which a test
  // that only checked the content was gone would not notice.
  assert.equal(filled.replace(row[0], ''), empty)
})

test('the row sits between the composer and the action row', () => {
  const filled = render(ATTACHED)
  const composer = filled.indexOf('</textarea>')
  const attached = filled.indexOf(ATTACHED)
  const actionRow = filled.indexOf('aria-label="Send"')

  assert.ok(composer >= 0 && attached >= 0 && actionRow >= 0, `missing landmark in:\n${filled}`)
  assert.ok(composer < attached, 'the row must come after the composer, not above it')
  // The defect this whole change exists to correct: the chip rendered among
  // the send/settings controls because it was handed to a slot that lives
  // there.
  assert.ok(attached < actionRow, 'the row must come before the action row, not inside it')
})

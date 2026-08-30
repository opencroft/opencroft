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

// The requirement behind the row's position, as close as static markup gets to
// it. The panel is docked to the bottom of its container and grows upward, so
// the composer stays put exactly as long as NOTHING BELOW IT CHANGES when the
// row appears. Placing the row above the composer is what buys that; placing
// it anywhere below would move the composer by the row's height every time
// something was attached.
//
// This cannot see pixels, and the property it pins is not sufficient on its
// own -- a top-anchored host would still move the composer, and no assertion
// in this package can reach that. It is necessary, though, and it is the half
// that lives in this file. See the host-owns-the-anchor note on the component.
test('the row appearing changes nothing from the composer down', () => {
  const empty = render()
  const filled = render(ATTACHED)
  const from = (markup: string) => {
    const at = markup.indexOf('<textarea')
    assert.notEqual(at, -1, `no composer found in:\n${markup}`)
    return markup.slice(at)
  }

  assert.equal(from(filled), from(empty))
})

test('the row sits above the composer, not below it', () => {
  const filled = render(ATTACHED)
  const attached = filled.indexOf(ATTACHED)
  const composer = filled.indexOf('<textarea')
  const actionRow = filled.indexOf('aria-label="Send"')

  assert.ok(attached >= 0 && composer >= 0 && actionRow >= 0, `missing landmark in:\n${filled}`)
  assert.ok(attached < composer, 'the row must come before the composer, so the composer does not move')
  // Belt and braces on the original defect: the chip rendered among the
  // send/settings controls because it was handed to a slot that lives there.
  assert.ok(composer < actionRow, 'the action row must stay last')
})

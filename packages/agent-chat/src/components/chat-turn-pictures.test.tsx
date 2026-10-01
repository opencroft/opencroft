// A sent picture's box is in the markup before the picture loads.
//
// Static markup is exactly the moment that matters: it is what a browser lays
// out before a single byte of the image has arrived. Whatever box is described
// here is the box the picture occupies when it lands, so a picture with nothing
// here would take zero height first and its full height later, and move every
// line under it.

import assert from 'node:assert/strict'
import test from 'node:test'

import { renderToStaticMarkup } from 'react-dom/server'

import type { ChatTurnRenderers, ChatUserMessagePart, MessageAttachment, UserText } from './chat-turn'
import { ChatUserMessage } from './chat-turn'

const renderers = {
  Chained: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
} as unknown as ChatTurnRenderers

function pictureTag(attachment: MessageAttachment): string {
  const part: ChatUserMessagePart = { text: '' as UserText, attachments: [attachment] }
  const html = renderToStaticMarkup(<ChatUserMessage parts={[part]} renderers={renderers} />)
  const tag = html.match(/<img [^>]*>/g)
  assert.equal(tag?.length, 1, 'one picture sent, one picture drawn')
  return tag[0]
}

test('a picture of known size is laid out at its final size before it loads', () => {
  const tag = pictureTag({ label: 'wide.png', src: '/pictures/wide.png', width: 640, height: 480 })
  // The attributes are what the browser takes the ratio from, for the height.
  assert.match(tag, /width="640"/)
  assert.match(tag, /height="480"/)
  // Narrowed so its height stays within the bound: 192 * 640 / 480.
  assert.match(tag, /style="width:256px"/)
  assert.doesNotMatch(tag, /size-48/)
})

test('a picture smaller than the bound keeps its own width', () => {
  const tag = pictureTag({ label: 'icon.png', src: '/pictures/icon.png', width: 100, height: 50 })
  assert.match(tag, /style="width:100px"/)
})

test('a picture of unknown size takes a fixed box', () => {
  const tag = pictureTag({ label: 'old.png', src: '/pictures/old.png' })
  assert.match(tag, /size-48/)
  assert.doesNotMatch(tag, /width=|style=/)
})

test('half a size is no size', () => {
  const tag = pictureTag({ label: 'half.png', src: '/pictures/half.png', width: 640 })
  assert.match(tag, /size-48/)
  assert.doesNotMatch(tag, /width=|style=/)
})

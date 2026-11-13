// What the turn's action menu offers, as opposed to what a handler's presence
// might suggest is on offer.
//
// The menu replaced a hover pencil, and the two fail differently: a stale
// pencil is one dead button, while a menu that renders for a message it cannot
// act on, or omits the copy action for a message that holds the words, hides
// its omissions inside a closed popover. These tests hold where the menu is
// drawn against the actual markup; what each one offers, opened, is in
// `./chat-turn-message-menu.test.tsx`.

import assert from 'node:assert/strict'
import test from 'node:test'

import { renderToStaticMarkup } from 'react-dom/server'

import type { ChatTurnRenderers, ChatUserMessagePart, UserText } from './chat-turn'
import { ChatUserMessage } from './chat-turn'

const renderers = {
  Chained: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
} as unknown as ChatTurnRenderers

function part(text: string): ChatUserMessagePart {
  return { text: text as UserText }
}

// Two messages from one sender: the first is mid-turn, the second hands the
// turn over -- the only one the actions may ride.
const TURN = [part('first words'), part('second words')]

const MENU_TRIGGER_ARIA = 'aria-label="Message actions"'

function render(parts: ChatUserMessagePart[], handlers: { onEdit?: () => void; onFork?: () => void }): string {
  return renderToStaticMarkup(
    <ChatUserMessage
      blockId='u:0'
      parts={parts}
      renderers={renderers}
      onEdit={handlers.onEdit}
      onFork={handlers.onFork}
    />,
  )
}

test('every message carries its own action menu, mid-turn and ending alike', () => {
  const html = render(TURN, { onEdit: () => {}, onFork: () => {} })
  assert.equal(html.split(MENU_TRIGGER_ARIA).length - 1, 2, 'one menu per message')
})

test('a conversation whose host offers neither edit nor fork still gives each message its menu', () => {
  const html = render(TURN, {})
  assert.equal(html.split(MENU_TRIGGER_ARIA).length - 1, 2, 'copy and reply act on any message')
})

test('the pencil trigger is gone: edit lives in the menu now', () => {
  const html = render(TURN, { onEdit: () => {} })
  assert.ok(!html.includes('Edit message'), 'the standalone edit button must not linger beside the menu')
})

test('the header keeps author and send time together when a menu rides along', () => {
  const withTime: ChatUserMessagePart[] = [{ ...part('words'), author: 'Reader', sentAt: '2026-09-17T10:00:00.000Z' }]
  const html = render(withTime, { onEdit: () => {} })
  const authorAt = html.indexOf('Reader')
  const timeAt = html.indexOf('<time')
  const menuAt = html.indexOf(MENU_TRIGGER_ARIA)
  assert.ok(authorAt !== -1 && timeAt !== -1 && menuAt !== -1, 'all three header parts render')
  assert.ok(authorAt < timeAt && timeAt < menuAt, 'time sits between the name and the menu, not across the row')
})

// Whether messages still waiting group the same way as the same messages once
// they have been read.
//
// The grouping rule compares a message with the one immediately above it
// WITHIN the parts it is handed. Both surfaces call the same component with
// the same rule, and they still disagreed: the queue called it once per
// message, so every row was a run of one, every row opened a run, and every
// row drew a face. Sharing a renderer is not sharing the context the renderer
// reasons over.
//
// So the claim under test is an agreement between two surfaces, and it is
// asserted as one -- not as two copies of an expected pattern, which would go
// on passing if both sides moved together in the wrong direction.

import assert from 'node:assert/strict'
import test from 'node:test'

import type { ReactNode } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'

import type { ChatTurnRenderers, UserText } from './chat-turn'
import { ChatUserMessage } from './chat-turn'
import type { ChatUnreadMessage } from './chat-unread'
import { ChatUnread } from './chat-unread'

// The marker is wrapped in sentinels rather than an element, because the rail's
// content nests and the bodies beside it carry icons of their own -- an
// element-based match would have to balance tags to say which svg belongs to
// which segment, and these do not nest.
const RAIL_OPEN = '[[rail'
const RAIL_CLOSE = 'rail]]'

const renderers = {
  Chained: ({ marker, children }: { marker: ReactNode; children: ReactNode }) => (
    <div>
      {RAIL_OPEN}
      {marker}
      {RAIL_CLOSE}
      <div>{children}</div>
    </div>
  ),
} as unknown as ChatTurnRenderers

function waiting(id: string, author: string, name: string): ChatUnreadMessage {
  return { id, text: `message ${id}` as UserText, author, authorAccount: { name } }
}

// One entry per rendered message: did it draw a face.
//
// The avatar is the only svg that can appear between the sentinels; the remove
// and edit controls sit in the body, past RAIL_CLOSE.
function faces(html: string): boolean[] {
  const found: boolean[] = []
  let from = 0
  while (true) {
    const open = html.indexOf(RAIL_OPEN, from)
    if (open === -1) {
      return found
    }
    const close = html.indexOf(RAIL_CLOSE, open)
    assert.notEqual(close, -1, 'every rail marker must be closed, or the extraction is measuring nothing')
    found.push(html.slice(open, close).includes('<svg'))
    from = close + RAIL_CLOSE.length
  }
}

// Two from one sender, consecutively, then a third from another -- the shortest
// sequence in which "one face per sender change" and "one face per message"
// give different answers.
const THREE: ChatUnreadMessage[] = [
  waiting('m1', 'alex', 'Alex Rivera'),
  waiting('m2', 'alex', 'Alex Rivera'),
  waiting('m3', 'sam', 'Sam Doyle'),
]

test('messages waiting to be read group exactly as the same messages do once delivered', () => {
  const queued = faces(renderToStaticMarkup(<ChatUnread messages={THREE} renderers={renderers} />))
  const delivered = faces(renderToStaticMarkup(<ChatUserMessage parts={THREE} renderers={renderers} />))

  assert.deepEqual(queued, delivered)
})

test('the sequence the two agree on is the grouped one, not a face on every row', () => {
  // Without this the agreement above is satisfied by all-true, all-false, or
  // by both extractions finding nothing at all -- which is the shape the
  // defect actually had, since one face per row IS a consistent answer.
  const queued = faces(renderToStaticMarkup(<ChatUnread messages={THREE} renderers={renderers} />))

  assert.deepEqual(queued, [true, false, true])
})

test('every waiting message keeps its own remove control', () => {
  // The fix hands the queue over as one turn. Edit belongs to a turn, but
  // remove belongs to a message, and a turn-level control would have offered it
  // on the last message only -- silently dropping the only way to take back the
  // other two.
  const html = renderToStaticMarkup(
    <ChatUnread messages={THREE} onRemove={() => {}} renderers={renderers} />,
  )

  assert.equal(html.match(/title="Remove message"/g)?.length, THREE.length)
})

test('a delivered turn offers no remove control, because its messages carry no id', () => {
  // The same component, the same prop, and nothing rendered: the control is
  // gated on the message having an identity to be taken back by, which only a
  // message still waiting has.
  const parts = THREE.map((message) => ({
    text: message.text,
    author: message.author,
    authorAccount: message.authorAccount,
  }))
  const html = renderToStaticMarkup(
    <ChatUserMessage parts={parts} onRemove={() => assert.fail('nothing to remove')} renderers={renderers} />,
  )

  assert.equal(html.match(/title="Remove message"/g), null)
})

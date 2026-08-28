// Whether messages still waiting group the same way as the same messages once
// they have been read.
//
// The grouping rule cuts a sequence into runs of one sender WITHIN the parts it
// is handed. Both surfaces call the same component with the same rule, and they
// still disagreed: the queue called it once per message, so every row was a run
// of one, every row was its own rail segment, and every row drew a face.
// Sharing a renderer is not sharing the context the renderer reasons over.
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

// The rail's marker and body are wrapped in sentinels rather than elements,
// because both nest and carry icons of their own -- an element-based match
// would have to balance tags to say which svg belongs to which segment, and
// these do not nest.
const RAIL_OPEN = '[[rail'
const RAIL_CLOSE = 'rail]]'
const BODY_OPEN = '[[body'
const BODY_CLOSE = 'body]]'

const renderers = {
  Chained: ({ marker, children }: { marker: ReactNode; children: ReactNode }) => (
    <div>
      {RAIL_OPEN}
      {marker}
      {RAIL_CLOSE}
      {BODY_OPEN}
      <div>{children}</div>
      {BODY_CLOSE}
    </div>
  ),
} as unknown as ChatTurnRenderers

function waiting(id: string, author: string, name: string): ChatUnreadMessage {
  return { id, text: `message ${id}` as UserText, author, authorAccount: { name } }
}

function between(html: string, open: string, close: string): string[] {
  const found: string[] = []
  let from = 0
  while (true) {
    const start = html.indexOf(open, from)
    if (start === -1) {
      return found
    }
    const end = html.indexOf(close, start)
    assert.notEqual(end, -1, 'every sentinel must be closed, or the extraction is measuring nothing')
    found.push(html.slice(start + open.length, end))
    from = end + close.length
  }
}

// One entry per rail SEGMENT -- which is one per run, not one per message: did
// it draw a face, and which messages sit under it.
//
// The avatar is the only svg that can appear between the rail sentinels; the
// remove and edit controls sit in the body.
function grouping(html: string): { face: boolean; messages: string[] }[] {
  const rails = between(html, RAIL_OPEN, RAIL_CLOSE)
  const bodies = between(html, BODY_OPEN, BODY_CLOSE)
  assert.equal(rails.length, bodies.length, 'every segment has one rail and one body')
  return rails.map((rail, index) => ({
    face: rail.includes('<svg'),
    messages: [...bodies[index]!.matchAll(/message (m\d+)/g)].map((match) => match[1]!),
  }))
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
  const queued = grouping(renderToStaticMarkup(<ChatUnread messages={THREE} renderers={renderers} />))
  const delivered = grouping(renderToStaticMarkup(<ChatUserMessage parts={THREE} renderers={renderers} />))

  assert.deepEqual(queued, delivered)
})

test('the shape the two agree on is the grouped one, not a segment per row', () => {
  // Without this the agreement above is satisfied by a face on every row, by no
  // face anywhere, or by both extractions finding nothing at all -- and one
  // segment per row IS a consistent answer, which is the shape the defect
  // actually had, twice.
  const queued = grouping(renderToStaticMarkup(<ChatUnread messages={THREE} renderers={renderers} />))

  assert.deepEqual(queued, [
    { face: true, messages: ['m1', 'm2'] },
    { face: true, messages: ['m3'] },
  ])
})

test('every waiting message keeps its own remove control', () => {
  // The fix hands the queue over as one turn, and its runs over as one segment
  // each. Edit belongs to a turn, but remove belongs to a message, and a
  // control per turn -- or per run -- would have offered it on one message only,
  // silently dropping the only way to take back the others.
  const html = renderToStaticMarkup(<ChatUnread messages={THREE} onRemove={() => {}} renderers={renderers} />)

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

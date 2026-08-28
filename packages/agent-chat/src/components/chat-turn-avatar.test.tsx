// What the rail actually renders, as opposed to what the grouping rule says is
// due.
//
// `authorRuns` is tested on its own and answers "where does one sender's run
// end". It cannot answer "is there one face in the markup, beside the whole
// run", and the two came apart twice:
//
//   * the rule said a face was due for a message whose sender could not be
//     identified, and the avatar drew a generic person icon for it -- a picture
//     of somebody standing in for every author this application cannot name;
//   * the rule grouped correctly and the rail drew a segment per MESSAGE, so
//     the face landed on the message that opened the run and every message
//     under it got an avatar-sized blank. Grouped by the rule, ungrouped on the
//     screen.
//
// The condition behind the first, `run.account`, reads like a null-guard. It is
// not one: it is the difference between a face and a claim about who spoke, and
// a later tidy-up "simplifying" it away would restore the defect silently. A
// comment asks for that; this enforces it.

import assert from 'node:assert/strict'
import test from 'node:test'

import type { ReactNode } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'

import type { ChatAuthorAccount, ChatTurnRenderers, ChatUserMessagePart, UserText } from './chat-turn'
import { ChatUserMessage } from './chat-turn'

// Rail segments are wrapped in sentinels rather than matched as elements: the
// bodies beside the rail carry elements of their own, so an element-based match
// would have to balance tags to say where one segment ends. Segments never
// nest, so a pair of literals is enough.
const SEGMENT_OPEN = '[[segment'
const SEGMENT_CLOSE = 'segment]]'

// Only what this component reaches for. `Chained` is the rail itself, so it is
// real enough to place a marker; everything else is unused on this path and
// would be scaffolding pretending to be a test double.
const renderers = {
  Chained: ({ marker, children }: { marker: ReactNode; children: ReactNode }) => (
    <div>
      {SEGMENT_OPEN}
      <div>{marker}</div>
      <div>{children}</div>
      {SEGMENT_CLOSE}
    </div>
  ),
} as unknown as ChatTurnRenderers

// The markup of each rail segment, in order.
function segments(html: string): string[] {
  const found: string[] = []
  let from = 0
  while (true) {
    const open = html.indexOf(SEGMENT_OPEN, from)
    if (open === -1) {
      return found
    }
    const close = html.indexOf(SEGMENT_CLOSE, open)
    assert.notEqual(close, -1, 'every segment must be closed, or the extraction is measuring nothing')
    found.push(html.slice(open + SEGMENT_OPEN.length, close))
    from = close + SEGMENT_CLOSE.length
  }
}

function said(author: string, account?: ChatAuthorAccount, text = 'the build is red'): ChatUserMessagePart {
  // The positive control depends on this key arriving. Spread into the literal
  // it is not checked by the return annotation, so a rename here would leave
  // every assertion below passing over a part that has no account at all.
  return {
    text: text as UserText,
    author,
    ...(account ? ({ authorAccount: account } satisfies Pick<ChatUserMessagePart, 'authorAccount'>) : {}),
  }
}

// The avatar renders an `<Avatar>` box with a `<User>` icon inside it; the blank
// that holds a run's left edge is a plain span. Matching on the svg is what
// tells them apart -- the blank has no children at all.
const AVATAR = /<svg/

// The blank itself, which is the thing a run must NOT be full of. `size-8` alone
// would match the avatar too, since both are the same size by design.
const BLANK = /class="block size-8"/g

const ADA: ChatAuthorAccount = { name: 'Ada Rivera' }
const BO: ChatAuthorAccount = { name: 'Bo Nakamura' }

test('a message whose sender cannot be identified renders no avatar', () => {
  // The defect this file exists for. The message DOES open a run -- it is the
  // only one -- so the rule says a face is due, and there is no account to draw
  // one from.
  const html = renderToStaticMarkup(<ChatUserMessage parts={[said('Alex Rivera')]} renderers={renderers} />)

  assert.doesNotMatch(html, AVATAR, 'an unidentified sender must stay visibly unidentified')
  assert.match(html, /Alex Rivera/, 'and still shows the text the message holds')
})

test('a message from an account that resolved renders its avatar', () => {
  // The other half, so the test above cannot pass by nothing ever rendering an
  // avatar at all -- which is how a "no avatar" assertion quietly stops meaning
  // anything.
  const html = renderToStaticMarkup(<ChatUserMessage parts={[said('ada', ADA)]} renderers={renderers} />)

  assert.match(html, AVATAR, 'a resolved account is drawn')
  assert.match(html, /Ada Rivera/)
})

test('a run is ONE rail segment holding every message in it', () => {
  // The rendered half of the grouping rule, and the regression that a correct
  // rule cannot catch on its own: a segment per message groups nothing, because
  // the face has no run to sit beside.
  const html = renderToStaticMarkup(
    <ChatUserMessage
      parts={[said('ada', ADA, 'the build is red'), said('ada', ADA, 'still red'), said('bo', BO, 'looking now')]}
      renderers={renderers}
    />,
  )
  const rail = segments(html)

  assert.equal(rail.length, 2, 'three messages, two senders, two segments')
  assert.match(rail[0]!, /the build is red/)
  assert.match(rail[0]!, /still red/, "both of one sender's messages live in that sender's own segment")
  assert.match(rail[1]!, /looking now/)
})

test('a run draws one face, and no blanks under it', () => {
  const html = renderToStaticMarkup(
    <ChatUserMessage parts={[said('ada', ADA), said('ada', ADA)]} renderers={renderers} />,
  )

  assert.equal(html.match(/<svg/g)?.length, 1, 'the second message continues the run rather than repeating the face')
  assert.equal(
    html.match(BLANK),
    null,
    "a message inside a run holds no avatar-sized blank -- it shares the run's face",
  )
})

test('a change of sender inside one delivery draws a second face', () => {
  const html = renderToStaticMarkup(
    <ChatUserMessage parts={[said('ada', ADA), said('bo', BO)]} renderers={renderers} />,
  )

  assert.equal(html.match(/<svg/g)?.length, 2, 'two senders, two faces')
  assert.equal(segments(html).length, 2)
})

test('a run whose sender did not resolve draws the blank once, not once per message', () => {
  // The blank holds the left edge for a run with no face. One per run is the
  // rail staying a fixed width; one per message would be the per-message rail
  // back again, wearing the case that has no avatar to make it obvious.
  const html = renderToStaticMarkup(
    <ChatUserMessage parts={[said('kim'), said('kim'), said('kim')]} renderers={renderers} />,
  )

  assert.equal(html.match(BLANK)?.length, 1)
})

test('every run holds the top edge while its own messages scroll under it', () => {
  // The turn slides its whole self past the container's edge, so a face pinned
  // on the LAST run only -- which is what the collapsing header wants for its
  // own hand-off -- leaves every earlier run passing unattributed. Asserted
  // against the run count rather than "at least one", because one is exactly
  // what the defect rendered.
  //
  // Matched on the class because the class IS the mechanism: `position: sticky`
  // against the scrollport's top edge. A test that could not see it would not
  // be able to tell this apart from a face that simply scrolls away.
  const html = renderToStaticMarkup(
    <ChatUserMessage
      sticky
      blockId='u:1'
      parts={[said('ada', ADA), said('ada', ADA), said('bo', BO)]}
      renderers={renderers}
    />,
  )

  assert.equal(html.match(/class="sticky top-0[^"]*"/g)?.length, 2, 'one pinned face per run, not one per turn')
})

test('a turn that does not take part in pinning pins nothing', () => {
  // The queue waiting below the transcript holds no edge, so its faces stay in
  // the flow. Same component, same runs -- the difference is the caller's, and
  // this is what keeps `sticky` meaning one thing.
  const html = renderToStaticMarkup(
    <ChatUserMessage parts={[said('ada', ADA), said('bo', BO)]} renderers={renderers} />,
  )

  assert.equal(html.match(/class="sticky top-0[^"]*"/g), null)
})

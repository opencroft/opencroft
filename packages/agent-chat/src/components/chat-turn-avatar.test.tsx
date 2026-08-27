// Whether a face is actually rendered, as opposed to whether the rule says
// one is due.
//
// `facesInRun` is tested on its own and answers "does this message open a
// run". It cannot answer "is an avatar in the markup", and the two came apart
// once already: the rule said yes for a message whose sender could not be
// identified, and the avatar drew a generic person icon for it -- a picture of
// somebody standing in for every author this application cannot name.
//
// The condition that fixes it, `faces[index] && part.authorAccount`, reads
// like a null-guard. It is not one: it is the difference between a face and a
// claim about who spoke, and a later tidy-up "simplifying" it away would
// restore the defect silently. A comment asks for that; this enforces it.

import assert from 'node:assert/strict'
import test from 'node:test'

import type { ReactNode } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'

import type { ChatTurnRenderers, ChatUserMessagePart, UserText } from './chat-turn'
import { ChatUserMessage } from './chat-turn'

// Only what this component reaches for. `Chained` is the rail itself, so it is
// real enough to place a marker; everything else is unused on this path and
// would be scaffolding pretending to be a test double.
const renderers = {
  Chained: ({ marker, children }: { marker: ReactNode; children: ReactNode }) => (
    <div>
      <div data-rail>{marker}</div>
      <div>{children}</div>
    </div>
  ),
} as unknown as ChatTurnRenderers

function said(author: string, account?: { name: string; avatarUrl?: string | null }): ChatUserMessagePart {
  // The positive control depends on this key arriving. Spread into the literal
  // it is not checked by the return annotation, so a rename here would leave
  // every assertion below passing over a part that has no account at all.
  return {
    text: 'the build is red' as UserText,
    author,
    ...(account ? ({ authorAccount: account } satisfies Pick<ChatUserMessagePart, 'authorAccount'>) : {}),
  }
}

// The avatar renders an `<Avatar>` box with a `<User>` icon inside it; the
// blank that holds a message's left edge is a plain span. Matching on the svg
// is what tells them apart -- the blank has no children at all.
const AVATAR = /<svg/

test('a message whose sender cannot be identified renders no avatar', () => {
  // The defect this file exists for. The message DOES open a run -- it is the
  // only one -- so the rule says a face is due, and there is no account to
  // draw one from.
  const html = renderToStaticMarkup(<ChatUserMessage parts={[said('Alex Rivera')]} renderers={renderers} />)

  assert.doesNotMatch(html, AVATAR, 'an unidentified sender must stay visibly unidentified')
  assert.match(html, /Alex Rivera/, 'and still shows the text the message holds')
})

test('a message from an account that resolved renders its avatar', () => {
  // The other half, so the test above cannot pass by nothing ever rendering an
  // avatar at all -- which is how a "no avatar" assertion quietly stops
  // meaning anything.
  const html = renderToStaticMarkup(
    <ChatUserMessage parts={[said('ada', { name: 'Ada Rivera' })]} renderers={renderers} />,
  )

  assert.match(html, AVATAR, 'a resolved account is drawn')
  assert.match(html, /Ada Rivera/)
})

test('a run draws one face, on the message that opens it', () => {
  const html = renderToStaticMarkup(
    <ChatUserMessage
      parts={[said('ada', { name: 'Ada Rivera' }), said('ada', { name: 'Ada Rivera' })]}
      renderers={renderers}
    />,
  )

  assert.equal(html.match(/<svg/g)?.length, 1, 'the second message continues the run rather than repeating the face')
})

test('a change of sender inside one delivery draws a second face', () => {
  const html = renderToStaticMarkup(
    <ChatUserMessage
      parts={[said('ada', { name: 'Ada Rivera' }), said('bo', { name: 'Bo Nakamura' })]}
      renderers={renderers}
    />,
  )

  assert.equal(html.match(/<svg/g)?.length, 2, 'two senders, two faces')
})

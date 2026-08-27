// When a face is drawn beside a message.
//
// The sequence in the first test is the specification itself, written out
// in full, and it is the whole rule: the fourth message shows a face even
// though its sender already appeared above, because the run was broken by
// somebody else in between.

import assert from 'node:assert/strict'
import test from 'node:test'

import { facesInRun } from './author-runs'
import type { ChatUserMessagePart, UserText } from './components/chat-turn'

const said = (author: string | undefined, text = 'hello'): ChatUserMessagePart => ({
  text: text as UserText,
  author,
})

const withAccount = (author: string, name: string): ChatUserMessagePart => ({
  text: 'hello' as UserText,
  author,
  authorAccount: { name },
})

test('a face is drawn when the author changes, and again when a run resumes', () => {
  // alice — show / alice — do not show / erin — show / alice — show
  assert.deepEqual(facesInRun([said('alice'), said('alice'), said('erin'), said('alice')]), [true, false, true, true])
})

test('the comparison is against the message above, not against everyone seen so far', () => {
  // The same claim isolated, because it is the one a "have we already shown
  // this author?" implementation gets wrong while passing every other case.
  const faces = facesInRun([said('alice'), said('erin'), said('alice'), said('erin')])

  assert.deepEqual(faces, [true, true, true, true], 'every message begins a run when senders alternate')
})

test('a new turn always opens with a face, even when the same sender spoke last', () => {
  // The case the batch-local rule gets wrong if a run is ever carried across
  // calls. A turn is a delivery, and a delivery opens with its sender's face
  // whatever came before it -- so this function must have no memory between
  // one batch and the next, and starting the second sequence with the sender
  // who ended the first is what proves it.
  const firstTurn = facesInRun([said('alice'), said('alice')])
  const secondTurn = facesInRun([said('alice'), said('alice')])

  assert.deepEqual(firstTurn, [true, false])
  assert.deepEqual(secondTurn, [true, false], 'the second turn opens with a face rather than continuing the run')
})

test('a single sender speaking throughout shows one face, at the top', () => {
  assert.deepEqual(facesInRun([said('alice'), said('alice'), said('alice')]), [true, false, false])
})

test('one message shows one face', () => {
  assert.deepEqual(facesInRun([said('alice')]), [true])
})

test('nothing at all draws nothing', () => {
  assert.deepEqual(facesInRun([]), [])
})

test('grouping is by the stamped identifier, not by the name on screen', () => {
  // Two accounts displayed under one name. Grouping by what a reader sees
  // would fold them into a single run and put one sender's face on the
  // other's message -- which is the reason a display name is not the stamp.
  const faces = facesInRun([withAccount('ada', 'Alex Rivera'), withAccount('ada.l', 'Alex Rivera')])

  assert.deepEqual(faces, [true, true], 'a shared display name must not merge two accounts')
})

test('a message nobody sent draws no face and does not break the run around it', () => {
  // An application's own prompt, sitting between two messages from one
  // person. Nobody spoke, so the two who did are still adjacent.
  const faces = facesInRun([said('alice'), said(undefined), said('alice')])

  assert.deepEqual(faces, [true, false, false])
})

test('a message nobody sent still lets the next real change of author show', () => {
  const faces = facesInRun([said('alice'), said(undefined), said('erin')])

  assert.deepEqual(faces, [true, false, true])
})

// Where one sender's run of messages ends and the next begins.
//
// The sequence in the first test is the specification itself, written out in
// full, and it is the whole rule: the fourth message is its own run even
// though its sender already appeared above, because the run was broken by
// somebody else in between.
//
// This used to assert a boolean per message -- "does this one open a run" --
// and every claim it made is still made here, as run membership instead. The
// two say the same thing about grouping, but only the run shape can be drawn:
// a face shared by a run has to sit beside the run, and a flag can only mark
// one message of it. The rendered half of that lives in
// `components/chat-turn-avatar.test.tsx`.

import assert from 'node:assert/strict'
import test from 'node:test'

import { authorRuns } from './author-runs'
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

// Who is in each run, in order. Asserting the whole shape rather than a count
// of runs: a count agrees with the wrong grouping as often as with the right
// one, and the case that decides this rule is WHICH run a message landed in.
const shape = (parts: readonly ChatUserMessagePart[]) =>
  authorRuns(parts).map((run) => run.parts.map((part) => part.author))

test('a run ends when the author changes, and a returning sender opens a new one', () => {
  // kim, kim / lee / kim -- three runs, and the last kim is not folded
  // back into the first.
  assert.deepEqual(shape([said('kim'), said('kim'), said('lee'), said('kim')]), [
    ['kim', 'kim'],
    ['lee'],
    ['kim'],
  ])
})

test('the comparison is against the message above, not against everyone seen so far', () => {
  // The same claim isolated, because it is the one a "have we already shown
  // this author?" implementation gets wrong while passing every other case: it
  // would produce two runs here instead of four.
  assert.deepEqual(shape([said('kim'), said('lee'), said('kim'), said('lee')]), [
    ['kim'],
    ['lee'],
    ['kim'],
    ['lee'],
  ])
})

test('a new turn always opens a new run, even when the same sender spoke last', () => {
  // The case the batch-local rule gets wrong if a run is ever carried across
  // calls. A turn is a delivery, and a delivery opens with its sender's face
  // whatever came before it -- so this function must have no memory between one
  // batch and the next, and starting the second sequence with the sender who
  // ended the first is what proves it.
  const firstTurn = shape([said('kim'), said('kim')])
  const secondTurn = shape([said('kim'), said('kim')])

  assert.deepEqual(firstTurn, [['kim', 'kim']])
  assert.deepEqual(secondTurn, [['kim', 'kim']], 'the second turn opens its own run rather than continuing the first')
})

test('a single sender speaking throughout is one run', () => {
  assert.deepEqual(shape([said('kim'), said('kim'), said('kim')]), [['kim', 'kim', 'kim']])
})

test('one message is one run', () => {
  assert.deepEqual(shape([said('kim')]), [['kim']])
})

test('nothing at all is no runs', () => {
  assert.deepEqual(authorRuns([]), [])
})

test('grouping is by the stamped identifier, not by the name on screen', () => {
  // Two accounts displayed under one name. Grouping by what a reader sees would
  // fold them into a single run and put one sender's face on the other's
  // message -- which is the reason a display name is not the stamp.
  assert.deepEqual(
    shape([withAccount('ada', 'Alex Rivera'), withAccount('ada.l', 'Alex Rivera')]),
    [['ada'], ['ada.l']],
    'a shared display name must not merge two accounts',
  )
})

test('a message nobody sent does not break the run around it', () => {
  // An application's own prompt, sitting between two messages from one person.
  // Nobody spoke, so the two who did are still adjacent and it is all one run.
  assert.deepEqual(shape([said('kim'), said(undefined), said('kim')]), [['kim', undefined, 'kim']])
})

test('a message nobody sent still lets the next real change of author end the run', () => {
  assert.deepEqual(shape([said('kim'), said(undefined), said('lee')]), [['kim', undefined], ['lee']])
})

test('a message nobody sent, arriving first, opens a run of its own', () => {
  // The one case where an unauthored message does not continue a run: there is
  // none to continue. The second assertion is the reason it must not be
  // absorbed the other way either -- a run takes its account from the message
  // that opened it, so folding the real sender into the unauthored run would
  // draw that run from the message NOBODY sent, and the sender would lose their
  // face.
  const runs = authorRuns([said(undefined), withAccount('kim', 'Kim Alvarez')])

  assert.deepEqual(
    runs.map((run) => run.parts.map((part) => part.author)),
    [[undefined], ['kim']],
  )
  assert.deepEqual(runs[1]?.account, { name: 'Kim Alvarez' }, 'the sender who follows keeps their own face')
})

test('a run carries the account of the message that opened it', () => {
  // What the face is drawn from. Taken from the opening message rather than
  // searched for across the run: every message in a run carries the same
  // identifier, so any other message answering differently is a resolution
  // disagreement to surface, not one to paper over by picking whichever
  // message happens to have an account.
  const [run] = authorRuns([withAccount('ada', 'Ada Rivera'), withAccount('ada', 'Ada Rivera')])

  assert.deepEqual(run?.account, { name: 'Ada Rivera' })
})

test('a run whose sender did not resolve carries no account', () => {
  // The other half, so the assertion above cannot pass by every run carrying
  // whatever the first message held. An identifier written before accounts had
  // handles resolves to nothing, and the run must say so rather than borrow a
  // face.
  const [run] = authorRuns([said('kim'), said('kim')])

  assert.equal(run?.account, undefined)
})

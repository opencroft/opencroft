import assert from 'node:assert/strict'
import test from 'node:test'

import { filterMentions, insertMention, matchMentions, mentionToken } from './mention-autocomplete'

const PEOPLE = [
  { handle: 'agent.ada', name: 'Ada' },
  { handle: 'grace', name: 'Grace Hopper' },
  { handle: 'agent.alan', name: 'Alan Turing' },
]

const handles = (matches: { handle: string }[] | null) => matches?.map((match) => match.handle) ?? null

test('mentionToken finds an `@` at the start or after whitespace, up to the caret', () => {
  assert.deepEqual(mentionToken('@', 1), { start: 0, end: 1, query: '' })
  assert.deepEqual(mentionToken('hi @gr', 6), { start: 3, end: 6, query: 'gr' })
  assert.deepEqual(mentionToken('line\n@a', 7), { start: 5, end: 7, query: 'a' })
})

test('mentionToken ignores an `@` inside a word and one the caret has left', () => {
  assert.equal(mentionToken('mail@example', 12), null)
  assert.equal(mentionToken('@ada hello', 10), null)
  assert.equal(mentionToken('no sigil', 8), null)
  // The caret before the `@` is not in the mention.
  assert.equal(mentionToken('@ada', 0), null)
})

test('mentionToken ends at the caret, leaving what follows it out', () => {
  assert.deepEqual(mentionToken('@adx more', 2), { start: 0, end: 2, query: 'a' })
  assert.deepEqual(mentionToken('hello @adworld', 9), { start: 6, end: 9, query: 'ad' })
})

test('an `@` alone offers everyone, in the order given', () => {
  assert.deepEqual(handles(matchMentions(PEOPLE, '@', 1)), ['agent.ada', 'grace', 'agent.alan'])
})

test('a query finds a handle from its start, from a part after a dot, or by name', () => {
  assert.deepEqual(handles(matchMentions(PEOPLE, '@agent.a', 8)), ['agent.ada', 'agent.alan'])
  assert.deepEqual(handles(matchMentions(PEOPLE, '@ad', 3)), ['agent.ada'])
  assert.deepEqual(handles(matchMentions(PEOPLE, '@Ada', 4)), ['agent.ada'])
  assert.deepEqual(handles(matchMentions(PEOPLE, '@hop', 4)), ['grace'])
})

test('a query that begins no part falls back to anywhere in the handle or name', () => {
  assert.deepEqual(handles(matchMentions(PEOPLE, '@uring', 6)), ['agent.alan'])
})

test('filterMentions matches a bare query as matchMentions matches the one typed at the caret', () => {
  assert.deepEqual(handles(filterMentions(PEOPLE, '')), ['agent.ada', 'grace', 'agent.alan'])
  assert.deepEqual(handles(filterMentions(PEOPLE, 'TUR')), ['agent.alan'])
  assert.deepEqual(handles(filterMentions(PEOPLE, 'race')), ['grace'])
  assert.deepEqual(filterMentions(PEOPLE, 'zzz'), [])
  assert.deepEqual(filterMentions(PEOPLE, 'al'), matchMentions(PEOPLE, 'hi @al', 6))
})

test('nobody matching is an empty list, and no mention or nobody to offer is null', () => {
  assert.deepEqual(matchMentions(PEOPLE, '@zz', 3), [])
  assert.equal(matchMentions(PEOPLE, 'hello', 5), null)
  assert.equal(matchMentions([], '@', 1), null)
})

test('insertMention writes the handle and a space over the typed mention, caret after the space', () => {
  assert.deepEqual(insertMention('hi @gr', { start: 3, end: 6, query: 'gr' }, 'grace'), {
    text: 'hi @grace ',
    caret: 10,
  })
})

test('insertMention keeps the text after the word and reuses a space already there', () => {
  assert.deepEqual(insertMention('@gr and more', { start: 0, end: 3, query: 'gr' }, 'grace'), {
    text: '@grace and more',
    caret: 7,
  })
  assert.deepEqual(insertMention('@gr\nnext', { start: 0, end: 3, query: 'gr' }, 'grace'), {
    text: '@grace \nnext',
    caret: 7,
  })
})

test('insertMention keeps a word that follows the caret directly, set apart by the space', () => {
  const text = 'hello @adworld'
  const token = mentionToken(text, 9)
  assert.ok(token)
  assert.deepEqual(insertMention(text, token, 'agent.ada'), { text: 'hello @agent.ada world', caret: 17 })
})

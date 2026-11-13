import assert from 'node:assert/strict'
import test from 'node:test'

import type { MentionCandidate } from 'agent-chat/components/mention-autocomplete'

import {
  createMentionSource,
  MENTION_DIRECTORY_TTL_MS,
} from '@/app/_authed/(extension-runtime)/_client/markdown-mention-source'

const PEOPLE: MentionCandidate[] = [
  { handle: 'agent.ada', name: 'Ada' },
  { handle: 'bob', name: 'Bob Stone' },
]

const signal = new AbortController().signal

/** A loader that answers with `answers` in turn, counting its calls. */
function loader(...answers: Array<readonly MentionCandidate[] | Error>) {
  const calls = { count: 0 }
  const load = async () => {
    const answer = answers[Math.min(calls.count, answers.length - 1)]
    calls.count += 1
    if (answer instanceof Error) {
      throw answer
    }
    return answer
  }
  return { load, calls }
}

test('the list is fetched once and every query is matched against it as the composer matches', async () => {
  const { load, calls } = loader(PEOPLE)
  const source = createMentionSource(load, () => 0)

  assert.deepEqual(
    (await source.search('', signal)).map((person) => person.handle),
    ['agent.ada', 'bob'],
  )
  assert.deepEqual(
    (await source.search('sto', signal)).map((person) => person.handle),
    ['bob'],
  )
  assert.deepEqual(
    (await source.search('AD', signal)).map((person) => person.handle),
    ['agent.ada'],
  )
  assert.equal(calls.count, 1)
})

test('a list older than its lifetime is fetched again, so someone added since appears', async () => {
  let clock = 0
  const added: MentionCandidate[] = [...PEOPLE, { handle: 'cy', name: 'Cy' }]
  const { load, calls } = loader(PEOPLE, added)
  const source = createMentionSource(load, () => clock)

  assert.deepEqual(await source.search('cy', signal), [])
  clock = MENTION_DIRECTORY_TTL_MS
  assert.deepEqual(await source.search('cy', signal), [], 'still within its lifetime')
  clock = MENTION_DIRECTORY_TTL_MS + 1
  assert.deepEqual(
    (await source.search('cy', signal)).map((person) => person.handle),
    ['cy'],
  )
  assert.equal(calls.count, 2)
})

test('a fetch that fails is not kept: the next @ asks again', async () => {
  const { load, calls } = loader(new Error('offline'), PEOPLE)
  const source = createMentionSource(load, () => 0)

  await assert.rejects(source.search('', signal), /offline/)
  assert.equal((await source.search('', signal)).length, 2)
  assert.equal(calls.count, 2)
})

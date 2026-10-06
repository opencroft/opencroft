// The search query against a real database: what a query matches, what it
// may not reach, and the snippet it answers with.
import '@opencroft/db/test-env'

import assert from 'node:assert/strict'
import test from 'node:test'

import { db, transcriptMessage } from '@opencroft/db'

import { indexedMessageAt, searchTranscripts, snippetParts } from './transcript-search'

let counter = 0
function nextKey(): string {
  counter += 1
  return `agent:test:transcript-search-${counter}`
}

async function seed(
  sessionKey: string,
  rows: { position: number; role: 'user' | 'agent'; segment?: number; turn?: number; text: string; createdAt?: Date }[],
): Promise<void> {
  await db.insert(transcriptMessage).values(
    rows.map((row) => ({
      sessionKey,
      segment: 0,
      turn: row.position,
      createdAt: new Date('2026-01-01T00:00:00Z'),
      ...row,
    })),
  )
}

const matchedWords = (snippet: { text: string; match: boolean }[]) =>
  snippet.filter((part) => part.match).map((part) => part.text)

test('every word of the query must appear, each matched as a prefix', async () => {
  const key = nextKey()
  await seed(key, [
    { position: 0, role: 'user', text: 'Please deploy the billing service' },
    { position: 4, role: 'agent', text: 'The billing tests are green' },
  ])
  const hits = await searchTranscripts([key], 'BILL deplo', 10)
  assert.deepEqual(
    hits.hits.map((hit) => [hit.position, hit.role]),
    [[0, 'user']],
  )
  assert.deepEqual(matchedWords(hits.hits[0].snippet), ['deploy', 'billing'])
})

test('a word the parser keeps whole, like a host name, is found whole', async () => {
  const key = nextKey()
  await seed(key, [{ position: 0, role: 'agent', text: 'It is served from api.example.com now' }])
  const hits = await searchTranscripts([key], 'api.example.com', 10)
  assert.equal(hits.hits.length, 1)
})

test('a session the caller did not pass is never matched', async () => {
  const mine = nextKey()
  const theirs = nextKey()
  await seed(mine, [{ position: 0, role: 'user', text: 'unrelated words' }])
  await seed(theirs, [{ position: 0, role: 'user', text: 'secret launch plan' }])
  assert.deepEqual((await searchTranscripts([mine], 'secret', 10)).hits, [])
  assert.deepEqual((await searchTranscripts([], 'secret', 10)).hits, [])
})

test('newest first, capped at the limit, and the cap is reported', async () => {
  const key = nextKey()
  await seed(
    key,
    [0, 1, 2].map((day) => ({
      position: day * 10,
      role: 'user' as const,
      text: `release notes day ${day}`,
      createdAt: new Date(Date.UTC(2026, 0, day + 1)),
    })),
  )
  const result = await searchTranscripts([key], 'release', 2)
  assert.deepEqual(
    result.hits.map((hit) => hit.position),
    [20, 10],
  )
  assert.equal(result.truncated, true)
  assert.equal((await searchTranscripts([key], 'release', 3)).truncated, false)
})

test('a hit names its message and the turn to open at', async () => {
  const key = nextKey()
  await seed(key, [
    { position: 3, role: 'user', text: 'what about billing' },
    { position: 4, role: 'agent', turn: 3, text: 'Billing is green' },
  ])
  const result = await searchTranscripts([key], 'green', 10)
  assert.deepEqual(
    result.hits.map((hit) => [hit.position, hit.role, hit.turn]),
    [[4, 'agent', 3]],
  )
})

test('the message starting at a position is read back whole, its segments joined', async () => {
  const key = nextKey()
  await seed(key, [
    { position: 7, role: 'agent', segment: 1, text: ' and the end' },
    { position: 7, role: 'agent', segment: 0, text: 'The start' },
  ])
  assert.deepEqual(await indexedMessageAt(key, 7), { role: 'agent', text: 'The start and the end' })
  assert.equal(await indexedMessageAt(key, 8), null)
})

test('a message whose segments add up past one SELECT is read back whole', async () => {
  // 640 segments of 32 KB, about 20 MiB: more than the embedded database
  // returns from one query.
  const key = nextKey()
  const segment = 's'.repeat(32 * 1024)
  for (let start = 0; start < 640; start += 64) {
    await seed(
      key,
      Array.from({ length: 64 }, (_, i) => ({ position: 2, role: 'user' as const, segment: start + i, text: segment })),
    )
  }
  const message = await indexedMessageAt(key, 2)
  assert.deepEqual([message?.role, message?.text.length], ['user', 640 * segment.length])
})

test('a reply matching in several segments is one hit, shown from its earliest matching segment', async () => {
  const key = nextKey()
  await seed(key, [
    { position: 0, role: 'agent', segment: 0, text: 'rollout begins today' },
    { position: 0, role: 'agent', segment: 1, text: 'nothing matching here' },
    {
      position: 0,
      role: 'agent',
      segment: 2,
      text: 'rollout finishes later',
      createdAt: new Date('2026-01-02T00:00:00Z'),
    },
  ])
  const result = await searchTranscripts([key], 'rollout', 10)
  assert.deepEqual(
    result.hits.map((hit) => [hit.position, hit.role, hit.snippet.map((part) => part.text).join('')]),
    [[0, 'agent', 'rollout begins today']],
  )
  assert.equal(result.truncated, false)
})

test('a query with no words in it answers nothing', async () => {
  const key = nextKey()
  await seed(key, [{ position: 0, role: 'user', text: 'anything at all' }])
  for (const query of ['', '   ', '!!! ---', "'"]) {
    assert.deepEqual(await searchTranscripts([key], query, 10), { hits: [], truncated: false }, `query ${query}`)
  }
})

test('quotes and operators in a query are words, not syntax', async () => {
  const key = nextKey()
  await seed(key, [{ position: 0, role: 'user', text: "it's a & b | c !d" }])
  const result = await searchTranscripts([key], "it's & | ! (", 10)
  assert.equal(result.hits.length, 1)
})

test('snippet parts split plain text from matched words', () => {
  assert.deepEqual(snippetParts('run the deploy script for billing'), [
    { text: 'run the ', match: false },
    { text: 'deploy', match: true },
    { text: ' script for ', match: false },
    { text: 'billing', match: true },
  ])
  assert.deepEqual(snippetParts('no match marked'), [{ text: 'no match marked', match: false }])
})

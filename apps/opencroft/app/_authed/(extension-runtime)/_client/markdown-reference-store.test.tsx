import assert from 'node:assert/strict'
import { afterEach, test } from 'node:test'

import type { MarkdownReference, MarkdownResolver } from '@opencroft/client'
import { getMarkdownReferences, installMarkdownReferences } from 'agent-chat/components/markdown-references'

import { ReferenceStore } from './markdown-reference-store'

const tick = () => new Promise((resolve) => setTimeout(resolve, 0))
const settled = async () => {
  await tick()
  await tick()
}

interface Recorded {
  resolver: MarkdownResolver
  calls: string[][]
  invalidate: (ids?: string[]) => void
}

function recording(overrides: Partial<MarkdownResolver> = {}): Recorded {
  const recorded: Recorded = { resolver: undefined as never, calls: [], invalidate: () => {} }
  recorded.resolver = {
    id: 'test.ticket',
    pattern: /\bT-\d+\b/,
    resolve: async (ids) => {
      recorded.calls.push(ids)
      return Object.fromEntries(
        ids.map((id): [string, MarkdownReference | null] => [id, id === 'T-404' ? null : { label: `Ticket ${id}` }]),
      )
    },
    subscribe: (invalidate) => {
      recorded.invalidate = invalidate
      return () => {}
    },
    ...overrides,
  }
  return recorded
}

const store = () => new ReferenceStore(() => null)

afterEach(() => installMarkdownReferences(null))

test('everything asked for in one tick is one resolve call, each identifier once', async () => {
  const { resolver, calls } = recording()
  const s = store()
  s.sync([resolver])
  for (const id of ['T-1', 'T-2', 'T-1', 'T-3', 'T-2']) {
    s.request('test.ticket', id)
  }
  await settled()
  assert.deepEqual(calls, [['T-1', 'T-2', 'T-3']])
  assert.deepEqual(s.get('test.ticket', 'T-2')?.reference, { label: 'Ticket T-2' })
  assert.deepEqual(s.stats, { resolveCalls: 1, idsRequested: 3 })
})

test('an answer is kept: asking again, or while on its way, asks nothing', async () => {
  const { resolver, calls } = recording()
  const s = store()
  s.sync([resolver])
  s.request('test.ticket', 'T-1')
  await tick()
  // In flight now.
  s.request('test.ticket', 'T-1')
  await settled()
  s.request('test.ticket', 'T-1')
  await settled()
  assert.deepEqual(calls, [['T-1']])
})

test('an identifier nothing answers to is unknown, not missing', async () => {
  const { resolver } = recording()
  const s = store()
  s.sync([resolver])
  s.request('test.ticket', 'T-404')
  await settled()
  assert.equal(s.get('test.ticket', 'T-404')?.status, 'unknown')
})

test('invalidation asks again for what is on screen and forgets the rest', async () => {
  const recorded = recording()
  const s = store()
  s.sync([recorded.resolver])
  s.request('test.ticket', 'T-1')
  s.request('test.ticket', 'T-2')
  await settled()
  const notified: string[] = []
  s.subscribe('test.ticket', 'T-1', () => notified.push('T-1'))
  recorded.invalidate()
  await settled()
  assert.deepEqual(recorded.calls, [['T-1', 'T-2'], ['T-1']])
  assert.equal(s.get('test.ticket', 'T-2'), undefined)
  assert.deepEqual(notified, ['T-1'])
  // Kept on screen while the new answer was on its way, then replaced.
  assert.equal(s.get('test.ticket', 'T-1')?.status, 'resolved')
})

test('a change announced while the answer is on its way asks again once it lands', async () => {
  let version = 1
  const pending: Array<() => void> = []
  const recorded = recording()
  recorded.resolver.resolve = (ids) => {
    recorded.calls.push(ids)
    // Answers as of when it was asked, delivered when the test says so.
    const asked = version
    return new Promise((resolve) => {
      pending.push(() => resolve(Object.fromEntries(ids.map((id) => [id, { label: `${id} v${asked}` }]))))
    })
  }
  const s = store()
  s.sync([recorded.resolver])
  s.subscribe('test.ticket', 'T-1', () => {})
  s.request('test.ticket', 'T-1')
  await settled()
  assert.equal(pending.length, 1)
  // The change lands while the first answer is still in flight.
  version = 2
  recorded.invalidate(['T-1'])
  await settled()
  assert.deepEqual(recorded.calls, [['T-1']])
  pending.shift()?.()
  await settled()
  assert.deepEqual(recorded.calls, [['T-1'], ['T-1']])
  pending.shift()?.()
  await settled()
  assert.equal(s.get('test.ticket', 'T-1')?.reference?.label, 'T-1 v2')
  // And it stays settled: nothing is asked a third time.
  s.request('test.ticket', 'T-1')
  await settled()
  assert.equal(recorded.calls.length, 2)
})

test('invalidating named identifiers leaves the others alone', async () => {
  const recorded = recording()
  const s = store()
  s.sync([recorded.resolver])
  s.request('test.ticket', 'T-1')
  s.request('test.ticket', 'T-2')
  await settled()
  s.subscribe('test.ticket', 'T-1', () => {})
  s.subscribe('test.ticket', 'T-2', () => {})
  recorded.invalidate(['T-2'])
  await settled()
  assert.deepEqual(recorded.calls, [['T-1', 'T-2'], ['T-2']])
})

test('a failed resolve records nothing, so the next request asks again', async () => {
  let fail = true
  const recorded = recording()
  const resolve = recorded.resolver.resolve
  recorded.resolver.resolve = async (ids) => {
    if (fail) {
      recorded.calls.push(ids)
      throw new Error('offline')
    }
    return resolve(ids)
  }
  const s = store()
  s.sync([recorded.resolver])
  const errors = console.error
  console.error = () => {}
  try {
    s.request('test.ticket', 'T-1')
    await settled()
  } finally {
    console.error = errors
  }
  assert.equal(s.get('test.ticket', 'T-1'), undefined)
  fail = false
  s.request('test.ticket', 'T-1')
  await settled()
  assert.equal(s.get('test.ticket', 'T-1')?.status, 'resolved')
})

test('a resolver that cannot say when things change is asked again after a minute', async () => {
  const recorded = recording({ subscribe: undefined })
  const s = store()
  s.sync([recorded.resolver])
  const realNow = Date.now
  let now = realNow()
  Date.now = () => now
  try {
    s.request('test.ticket', 'T-1')
    await settled()
    now += 30_000
    s.request('test.ticket', 'T-1')
    await settled()
    now += 31_000
    s.request('test.ticket', 'T-1')
    await settled()
  } finally {
    Date.now = realNow
  }
  assert.deepEqual(recorded.calls, [['T-1'], ['T-1']])
})

test('the installed source carries each usable pattern; a broken one is left out, not the rest', () => {
  const errors = console.error
  const logged: unknown[] = []
  console.error = (...args: unknown[]) => logged.push(args[0])
  try {
    store().sync([
      recording().resolver,
      { ...recording().resolver, id: 'bad.group', pattern: '(?<x>A)-\\d' },
      { ...recording().resolver, id: 'bad.syntax', pattern: '(' },
      { ...recording().resolver, id: 'lookbehind', pattern: '(?<![/.])X-\\d', match: 'url' },
      { ...recording().resolver, id: 'none', pattern: null },
    ])
  } finally {
    console.error = errors
  }
  assert.deepEqual(
    getMarkdownReferences()?.recognisers.map((r) => [r.kind, r.match]),
    [
      ['test.ticket', 'text'],
      ['lookbehind', 'url'],
    ],
  )
  assert.equal(logged.length, 2)
})

test('a watched pattern replaces the source when it arrives, and no resolvers means none installed', () => {
  let set: (pattern: string | null) => void = () => {}
  const s = store()
  s.sync([
    recording({
      pattern: null,
      watchPattern: (next) => {
        set = next
        return () => {}
      },
    }).resolver,
  ])
  assert.equal(getMarkdownReferences(), null)
  set('\\bK-\\d+\\b')
  assert.deepEqual(
    getMarkdownReferences()?.recognisers.map((r) => r.pattern),
    ['\\bK-\\d+\\b'],
  )
  s.sync([])
  assert.equal(getMarkdownReferences(), null)
})

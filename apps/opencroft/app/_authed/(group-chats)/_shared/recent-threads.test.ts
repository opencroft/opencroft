import assert from 'node:assert/strict'
import test from 'node:test'

import { LEGACY_RECENT_THREADS_MAX, parseRecentThreadIds } from '@/app/_authed/(group-chats)/_shared/recent-threads'

test('a stored value that is not a list of ids reads as an empty list', () => {
  for (const raw of [null, '', 'not json', '{"a":1}', '42', 'null']) {
    assert.deepEqual(parseRecentThreadIds(raw), [], `raw: ${raw}`)
  }
})

test('a stored list keeps its non-empty string ids, once each, up to the cap', () => {
  assert.deepEqual(parseRecentThreadIds(JSON.stringify(['a', 3, '', 'b', 'a', null, 'c'])), ['a', 'b', 'c'])
  const many = Array.from({ length: LEGACY_RECENT_THREADS_MAX + 5 }, (_, n) => `t${n}`)
  assert.equal(parseRecentThreadIds(JSON.stringify(many)).length, LEGACY_RECENT_THREADS_MAX)
})

import assert from 'node:assert/strict'
import test from 'node:test'

import { cachedParse, PARSE_CACHE_SIZE } from './parse-cache'

test('a key is parsed once and its result reused', () => {
  let parses = 0
  const parse = () => {
    parses++
    return { parsed: true }
  }
  const first = cachedParse('test:once', parse)
  assert.equal(cachedParse('test:once', parse), first)
  assert.equal(parses, 1)
})

test('the least recently used key is dropped past the cache size, and a read keeps a key recent', () => {
  let parses = 0
  const parse = () => ++parses
  cachedParse('test:kept', parse)
  cachedParse('test:dropped', parse)
  for (let i = 0; i < PARSE_CACHE_SIZE - 2; i++) {
    cachedParse(`test:fill-${i}`, parse)
  }
  cachedParse('test:kept', parse)
  cachedParse('test:one-more', parse)
  const before = parses
  cachedParse('test:kept', parse)
  assert.equal(parses, before, 'a key read again stays')
  cachedParse('test:dropped', parse)
  assert.equal(parses, before + 1, 'the least recently used key was parsed again')
})

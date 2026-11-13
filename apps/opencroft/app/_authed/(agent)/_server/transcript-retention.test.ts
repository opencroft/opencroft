import '@opencroft/db/test-env'

import assert from 'node:assert/strict'
import test from 'node:test'

import { KEEP_ALL, parseRetention, readTranscriptRetention, writeTranscriptRetention } from './transcript-retention'

test('both settings are off by default: everything is kept', async () => {
  assert.deepEqual(await readTranscriptRetention(), { maxEntries: null, cleanupAfterDays: null })
  assert.deepEqual(KEEP_ALL, { maxEntries: null, cleanupAfterDays: null })
})

test('a setting is a whole number of 1 or more, or empty for off', () => {
  assert.deepEqual(parseRetention({ maxEntries: 5000, cleanupAfterDays: 90 }), {
    maxEntries: 5000,
    cleanupAfterDays: 90,
  })
  assert.deepEqual(parseRetention({}), { maxEntries: null, cleanupAfterDays: null })
  assert.equal(parseRetention({ maxEntries: 0 }), null)
  assert.equal(parseRetention({ maxEntries: 2.5 }), null)
  assert.equal(parseRetention({ cleanupAfterDays: '30' }), null)
  assert.equal(parseRetention({ cleanupAfterDays: 100_000 }), null)
  assert.equal(parseRetention(null), null)
})

test('settings written are read back, and refused when they are not settings', async () => {
  assert.deepEqual(await writeTranscriptRetention({ maxEntries: 3000, cleanupAfterDays: null }), {
    maxEntries: 3000,
    cleanupAfterDays: null,
  })
  assert.deepEqual(await readTranscriptRetention(), { maxEntries: 3000, cleanupAfterDays: null })
  await assert.rejects(writeTranscriptRetention({ maxEntries: -1 }), /whole number/)
  await writeTranscriptRetention(KEEP_ALL)
  assert.deepEqual(await readTranscriptRetention(), KEEP_ALL)
})

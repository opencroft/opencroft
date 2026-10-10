// A host can put off building its reference source until a markdown surface
// could show a reference. The signal is module state that only ever turns on,
// so this file owns it: the tests run in order, before and after the first
// surface subscribes.
import assert from 'node:assert/strict'
import { test } from 'node:test'

import { subscribeMarkdownReferences, whenMarkdownReferencesWanted } from './markdown-references'

const calls: string[] = []

test('nothing is called while no surface has read the source', () => {
  whenMarkdownReferencesWanted(() => calls.push('waiting'))
  const cancel = whenMarkdownReferencesWanted(() => calls.push('cancelled'))
  cancel()

  assert.deepEqual(calls, [])
})

test('the first surface to subscribe calls every waiting host once, and not a cancelled one', () => {
  const stop = subscribeMarkdownReferences(() => {})
  subscribeMarkdownReferences(() => {})()
  stop()

  assert.deepEqual(calls, ['waiting'])
})

test('a host asking after a surface has subscribed is called at once', () => {
  whenMarkdownReferencesWanted(() => calls.push('late'))

  assert.deepEqual(calls, ['waiting', 'late'])
})

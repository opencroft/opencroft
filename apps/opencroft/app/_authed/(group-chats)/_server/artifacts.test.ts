import assert from 'node:assert/strict'
import test from 'node:test'

import { applyExactReplacement } from './artifacts'

test('replaces a unique fragment and leaves the rest alone', () => {
  const before = 'Pass 1 backfills.\nPass 2 switches reads.\nPass 3 drops columns.'
  const after = applyExactReplacement(before, 'Pass 2 switches reads.', 'Pass 2 switches reads behind a flag.', false)
  assert.equal(after, 'Pass 1 backfills.\nPass 2 switches reads behind a flag.\nPass 3 drops columns.')
})

test('refuses an ambiguous match rather than editing the first one', () => {
  // The whole point of the operation: a fragment appearing twice means the
  // caller does not know which one it is editing, and picking one silently is
  // the failure this prevents.
  assert.throws(() => applyExactReplacement('todo\nsomething\ntodo', 'todo', 'done', false), /appears 2 times/)
})

test('replaceAll is how a caller says it meant every occurrence', () => {
  assert.equal(applyExactReplacement('todo\nx\ntodo', 'todo', 'done', true), 'done\nx\ndone')
})

test('a fragment that is not there is refused, not silently ignored', () => {
  assert.throws(() => applyExactReplacement('some note', 'absent', 'x', false), /not found/)
})

test('an empty replacement removes the fragment', () => {
  assert.equal(applyExactReplacement('keep this. drop this.', ' drop this.', '', false), 'keep this.')
})

test('regex metacharacters in the fragment are literal', () => {
  // split/join rather than a RegExp: the fragment is arbitrary markdown, so
  // characters like * and ( must not acquire a meaning the caller never asked
  // for. A pattern-based implementation passes the tests above and fails here.
  const before = 'See note (a*b) for detail.'
  assert.equal(applyExactReplacement(before, '(a*b)', '(a+b)', false), 'See note (a+b) for detail.')
})

test('replaceAll with metacharacters replaces every literal occurrence', () => {
  assert.equal(applyExactReplacement('a*b and a*b', 'a*b', 'c', true), 'c and c')
})

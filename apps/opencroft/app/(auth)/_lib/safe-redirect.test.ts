// Asserts the SANITISED VALUE, not the redirect's behaviour.
//
// Driving a browser would pass today for the wrong reason: a cross-origin
// `pushState` throws SecurityError, so the client-side consumer fails closed by
// accident. The other consumer — Better Auth's `callbackURL` — becomes a real
// server-side redirect, and whether it catches the same input is a question
// about a dependency's parser rather than about this code. Testing the check
// itself is what does not depend on either.

import assert from 'node:assert/strict'
import test from 'node:test'

import { safeRedirect } from './safe-redirect'

// One case per row of the measurement that found this: the middle row is the
// one a prefix check lets through.
test('a protocol-relative URL is refused', () => {
  assert.equal(safeRedirect('//evil.com'), undefined)
})

test('a backslash cannot smuggle a foreign origin past the leading slash', () => {
  assert.equal(safeRedirect('/\\evil.com'), undefined)
  assert.equal(safeRedirect('/\\/evil.com'), undefined)
  assert.equal(safeRedirect('\\\\evil.com'), undefined)
})

test('an ordinary path is carried through', () => {
  assert.equal(safeRedirect('/normal/path'), '/normal/path')
})

test('an absolute URL is refused, whatever its scheme', () => {
  assert.equal(safeRedirect('https://evil.com/x'), undefined)
  assert.equal(safeRedirect('http://evil.com/x'), undefined)
  assert.equal(safeRedirect('javascript:alert(1)'), undefined)
  assert.equal(safeRedirect('data:text/html,<script>'), undefined)
})

// The guard's whole purpose is returning someone where they were headed, so
// the query and fragment have to survive or signing in loses the destination.
test('query and fragment survive', () => {
  assert.equal(safeRedirect('/space/default?tab=chat#node-7'), '/space/default?tab=chat#node-7')
})

test('non-strings and empties yield nothing to carry', () => {
  assert.equal(safeRedirect(undefined), undefined)
  assert.equal(safeRedirect(null), undefined)
  assert.equal(safeRedirect(''), undefined)
  assert.equal(safeRedirect(42), undefined)
  assert.equal(safeRedirect(['/a']), undefined)
})

// A value that resolves onto our origin is returned normalised rather than as
// given, so the consumers never spend the original string.
test('the returned value is the parsed path, not the input', () => {
  assert.equal(safeRedirect('/a/../b'), '/b')
  assert.equal(safeRedirect('/a//b'), '/a//b')
})

// The base is a reserved name precisely so this cannot happen, but assert it:
// if someone swapped it for a real host, a redirect to that host would start
// passing.
test('the sentinel base itself is not accepted as a destination', () => {
  assert.equal(safeRedirect('https://redirect.invalid/x'), '/x')
  assert.equal(safeRedirect('https://redirect.invalid.evil.com/x'), undefined)
})

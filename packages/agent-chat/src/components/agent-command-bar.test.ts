import assert from 'node:assert/strict'
import test from 'node:test'

import { commandBarControlClass, commandBarControlHeight } from './agent-command-bar'

// ---------------------------------------------------------------------------
// The two row metrics have to express the same height, and until now nothing
// said so. They are written out as separate literals on purpose -- a class
// name built by joining pieces is not a literal and would never be generated
// -- which is exactly what lets them drift apart silently: one is edited, the
// other is not, and the row goes uneven with every check still green.
//
// A host control takes whichever fits it: a square icon button takes the
// class whole, a variable-width one takes only the height and must NOT
// inherit `shrink-0` with it, since a control carrying text is the thing in
// that row that should give up width first.
// ---------------------------------------------------------------------------

test('the row height constant and the square-control class agree on the height', () => {
  const size = commandBarControlClass.match(/(?:^|\s)size-(\S+)/)?.[1]
  const height = commandBarControlHeight.match(/(?:^|\s)h-(\S+)/)?.[1]

  assert.ok(size, `commandBarControlClass should carry a size-* class, got ${commandBarControlClass}`)
  assert.ok(height, `commandBarControlHeight should carry an h-* class, got ${commandBarControlHeight}`)
  assert.equal(height, size, 'a square control and a variable-width one must stand at the same height')
})

test('only the square-control class fixes width, so a labelled control can yield', () => {
  assert.match(commandBarControlClass, /(?:^|\s)shrink-0(?:\s|$)/)
  assert.doesNotMatch(commandBarControlHeight, /(?:^|\s)shrink-0(?:\s|$)/)
})

import assert from 'node:assert/strict'
import test from 'node:test'

import { inspectorPlacement } from './inspector-placement'

const base = { open: true, isMobile: false, expanded: false, mobileVisible: false }

test('on a desktop the inspector docks, and covers the screen once expanded', () => {
  assert.deepEqual(inspectorPlacement(base), { expanded: false, docked: true, covers: false })
  assert.deepEqual(inspectorPlacement({ ...base, expanded: true }), { expanded: true, docked: false, covers: true })
})

test('with nothing to inspect there is no inspector, expanded or not', () => {
  assert.deepEqual(inspectorPlacement({ ...base, open: false, expanded: true }), {
    expanded: true,
    docked: false,
    covers: false,
  })
  assert.deepEqual(inspectorPlacement({ ...base, open: false, isMobile: true, mobileVisible: true }), {
    expanded: false,
    docked: false,
    covers: false,
  })
})

test('on a phone the inspector covers the screen only when asked to show', () => {
  const phone = { ...base, isMobile: true }
  assert.deepEqual(inspectorPlacement(phone), { expanded: false, docked: false, covers: false })
  assert.deepEqual(inspectorPlacement({ ...phone, mobileVisible: true }), {
    expanded: false,
    docked: false,
    covers: true,
  })
})

test('an inspector expanded on a desktop is not expanded once the layout turns to a phone', () => {
  // Expanded in landscape, then rotated to portrait: the phone's inspector
  // has no Collapse, so it must not cover the screen by being expanded.
  const rotated = { ...base, isMobile: true, expanded: true }
  assert.deepEqual(inspectorPlacement(rotated), { expanded: false, docked: false, covers: false })
  assert.deepEqual(inspectorPlacement({ ...rotated, mobileVisible: true }), {
    expanded: false,
    docked: false,
    covers: true,
  })
  // Rotated back, it is expanded again.
  assert.deepEqual(inspectorPlacement({ ...rotated, isMobile: false }), { expanded: true, docked: false, covers: true })
})

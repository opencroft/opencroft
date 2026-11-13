import assert from 'node:assert/strict'
import test from 'node:test'

import { clientPointOf } from '@/app/_authed/(dashboard)/_canvas/drag-pointer'

test('a mouse event gives the pointer where it is', () => {
  assert.deepEqual(clientPointOf({ clientX: 120, clientY: 45 }), { x: 120, y: 45 })
})

test('a touch in progress gives the finger on the screen', () => {
  assert.deepEqual(clientPointOf({ touches: [{ clientX: 30, clientY: 70 }], changedTouches: [] }), { x: 30, y: 70 })
})

test('a touch that has ended gives where the finger lifted', () => {
  assert.deepEqual(clientPointOf({ touches: [], changedTouches: [{ clientX: 8, clientY: 9 }] }), { x: 8, y: 9 })
})

test('an event that says nothing of a pointer gives none', () => {
  assert.equal(clientPointOf({ touches: [], changedTouches: [] }), null)
  assert.equal(clientPointOf(undefined), null)
})

import assert from 'node:assert/strict'
import test from 'node:test'

import { accountPagesFor } from '@/app/_shell/account-menu'

const labels = (isAdmin: boolean) => accountPagesFor(isAdmin).map((page) => page.label)

test('an administrator is offered Settings, Extensions and Administration, in that order', () => {
  assert.deepEqual(labels(true), ['Settings', 'Extensions', 'Administration'])
})

test('anyone else is offered Settings and Extensions, without Administration', () => {
  assert.deepEqual(labels(false), ['Settings', 'Extensions'])
})

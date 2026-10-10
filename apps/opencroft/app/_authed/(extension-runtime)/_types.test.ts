import assert from 'node:assert/strict'
import test from 'node:test'

import { compileErrorLocation } from './_types'

test('a build problem is located by as much as it knows', () => {
  assert.equal(compileErrorLocation({ file: 'src/client.tsx', message: 'm' }), 'src/client.tsx')
  assert.equal(compileErrorLocation({ file: 'src/client.tsx', line: 3, message: 'm' }), 'src/client.tsx:3')
  assert.equal(compileErrorLocation({ file: 'src/client.tsx', line: 3, column: 7, message: 'm' }), 'src/client.tsx:3:7')
})

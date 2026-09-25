import assert from 'node:assert/strict'
import test from 'node:test'

import { RequestError } from '@agentclientprotocol/sdk'

import { rpcErrorDetail, rpcErrorParts } from './errors'

test('a JSON-RPC error gives up its code and data, and anything else only its message', () => {
  const refused = RequestError.internalError({ details: 'Session not found' })
  assert.deepEqual(rpcErrorParts(refused), {
    code: -32603,
    message: 'Internal error',
    data: { details: 'Session not found' },
  })
  assert.deepEqual(rpcErrorParts(new Error('spawn failed')), { message: 'spawn failed' })
  assert.deepEqual(rpcErrorParts('plain'), { message: 'plain' })
})

test('the detail is what the data says in words, or its JSON when it says nothing in words', () => {
  assert.equal(rpcErrorDetail({ details: 'Session not found' }), 'Session not found')
  assert.equal(rpcErrorDetail({ message: ' quota exceeded ' }), 'quota exceeded')
  assert.equal(rpcErrorDetail('bare string'), 'bare string')
  assert.equal(rpcErrorDetail({ errorKind: 'transport_lost' }), '{"errorKind":"transport_lost"}')
  for (const empty of [undefined, null, {}, [], '  ']) {
    assert.equal(rpcErrorDetail(empty), undefined)
  }
})

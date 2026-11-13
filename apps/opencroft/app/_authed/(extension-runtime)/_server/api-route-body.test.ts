// What a request's body puts in an API Route's event, and what the route's
// Body and Text outputs then carry.
import assert from 'node:assert/strict'
import test from 'node:test'

import { runOutputValue } from '@/app/_authed/(extension-runtime)/_builtin/core/src/nodes/run-outputs'
import { requestBody } from './api-route-body'

const JSON_TYPE = 'application/json; charset=utf-8'

function request(method: string, body?: string, contentType?: string): Request {
  return new Request('http://127.0.0.1/api/route/orders', {
    method,
    body,
    headers: contentType ? { 'content-type': contentType } : {},
  })
}

/** The route's Body and Text outputs in a run whose event carries `read`. */
function outputs(read: object): { body: unknown; text: unknown } {
  return {
    body: runOutputValue('api-route', 'body', read),
    text: runOutputValue('api-route', 'text', read),
  }
}

test('a JSON object is the body, with no text', async () => {
  const read = await requestBody(request('POST', '{"user":{"age":42}}', JSON_TYPE))

  assert.deepEqual(read, { body: { user: { age: 42 } } })
  assert.deepEqual(outputs(read), { body: { user: { age: 42 } }, text: undefined })
})

test('a JSON list or scalar is the event body, and neither output carries it', async () => {
  for (const [raw, parsed] of [
    ['[1,2]', [1, 2]],
    ['42', 42],
    ['"hello"', 'hello'],
    ['null', null],
  ] as const) {
    const read = await requestBody(request('POST', raw, JSON_TYPE))

    assert.deepEqual(read, { body: parsed }, raw)
    assert.deepEqual(outputs(read), { body: undefined, text: undefined }, raw)
  }
})

test('JSON that does not parse is text only', async () => {
  const read = await requestBody(request('POST', '{"user":', JSON_TYPE))

  assert.deepEqual(read, { text: '{"user":' })
  assert.deepEqual(outputs(read), { body: undefined, text: '{"user":' })
})

test('a plain-text body is both the event body and the text', async () => {
  const read = await requestBody(request('PUT', 'hello there', 'text/plain'))

  assert.deepEqual(read, { body: 'hello there', text: 'hello there' })
  assert.deepEqual(outputs(read), { body: undefined, text: 'hello there' })
})

test('GET and HEAD read nothing', async () => {
  for (const method of ['GET', 'HEAD']) {
    const read = await requestBody(request(method, undefined, JSON_TYPE))

    assert.deepEqual(read, {}, method)
    assert.deepEqual(outputs(read), { body: undefined, text: undefined }, method)
  }
})

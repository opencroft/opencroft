import assert from 'node:assert/strict'
import test from 'node:test'

import { profileSendsHeaders, resolveHeaders } from './agent-headers-shared'

// Stands in for the Secrets Store's resolveValue: `secret:NAME` from a store,
// typed text as it is, and a name no store holds refused.
async function resolveValue(value: string): Promise<string> {
  const stored: Record<string, string> = { TENANT_TOKEN: 'tok-123' }
  if (!value.startsWith('secret:')) {
    return value
  }
  const found = stored[value.slice('secret:'.length)]
  if (found === undefined) {
    throw new Error(`no secret ${value}`)
  }
  return found
}

test('header values are resolved, typed or from a secret, over the base headers', async () => {
  const headers = await resolveHeaders(
    [
      { name: 'X-Tenant', value: 'acme' },
      { name: ' X-Token ', value: 'secret:TENANT_TOKEN' },
      { name: '', value: 'ignored' },
    ],
    resolveValue,
    { Authorization: 'Bearer k' },
  )
  assert.deepEqual(headers, { Authorization: 'Bearer k', 'X-Tenant': 'acme', 'X-Token': 'tok-123' })
})

test('a custom header replaces a base header differing only in case', async () => {
  assert.deepEqual(
    await resolveHeaders([{ name: 'authorization', value: 'Basic b' }], resolveValue, { Authorization: 'Bearer k' }),
    {
      authorization: 'Basic b',
    },
  )
})

test('a header naming a secret no store holds is refused rather than sent blank', async () => {
  await assert.rejects(resolveHeaders([{ name: 'X-Token', value: 'secret:MISSING' }], resolveValue), /MISSING/)
})

test('the profile sends headers only for a harness that takes them and an endpoint it names', () => {
  assert.equal(profileSendsHeaders(true, 'http://127.0.0.1:8080/v1'), true)
  assert.equal(profileSendsHeaders(true, '  '), false)
  assert.equal(profileSendsHeaders(true, undefined), false)
  assert.equal(profileSendsHeaders(false, 'http://127.0.0.1:8080/v1'), false)
})

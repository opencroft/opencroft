import assert from 'node:assert/strict'
import test from 'node:test'

import { gatewayDefaults } from './gateway-defaults'

const env = {
  OPENCROFT_OPENCLAW_GATEWAY_URL: 'https://gateway.example',
  OPENCROFT_OPENCLAW_GATEWAY_TOKEN: 'gw-token-000',
}

test('an OpenClaw agent falls back to the gateway URL and token', () => {
  assert.deepEqual(gatewayDefaults('openclaw', env), {
    baseUrl: 'https://gateway.example',
    apiKey: 'gw-token-000',
  })
})

test('the former OPENCLAW_GATEWAY_* names still supply them', (t) => {
  t.mock.method(console, 'warn', () => {})
  const former = { OPENCLAW_GATEWAY_URL: 'https://former.example', OPENCLAW_GATEWAY_TOKEN: 'gw-token-001' }
  assert.deepEqual(gatewayDefaults('openclaw', former), {
    baseUrl: 'https://former.example',
    apiKey: 'gw-token-001',
  })
})

test('no other harness gets the gateway defaults', () => {
  // Codex sends its profile key as a Bearer token to its base URL; a gateway
  // default here would send an OpenAI key to the OpenClaw gateway.
  for (const adapterId of [
    'codex',
    'codex-subscription',
    'claude',
    'claude-subscription',
    'qwen',
    'opencode',
    'native',
    'gemini',
  ]) {
    assert.deepEqual(gatewayDefaults(adapterId, env), {}, adapterId)
  }
})

test('unset vars give nothing even to OpenClaw', () => {
  assert.deepEqual(gatewayDefaults('openclaw', {}), {})
})

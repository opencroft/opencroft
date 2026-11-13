import assert from 'node:assert/strict'
import test from 'node:test'

import { findRedacted, REDACTED, redactNodeData } from './redact-node-data'

// Fixture values are placeholders; no real credential is used here.

test('hides a typed value under a credential-named property', () => {
  const data = {
    password: 'placeholder-pw',
    ttsApiKey: 'placeholder-tts',
    asrApiKey: 'placeholder-asr',
    chatApiKey: 'placeholder-chat',
    sessionToken: 'placeholder-token',
    secret: 'placeholder-secret',
    client_secret: 'placeholder-secret',
  }
  assert.deepEqual(redactNodeData(data, []), Object.fromEntries(Object.keys(data).map((key) => [key, REDACTED])))
})

test('returns a secret reference, an empty value and an ordinary field as they are', () => {
  const data = {
    password: 'secret:SERVER_PW',
    chatApiKey: '',
    address: 'example.com',
    maxTokens: 'many',
    secretKeys: ['SERVER_PW'],
    apiKeySecret: 'PROVIDER_KEY',
    authStoreId: 'store-1',
  }
  assert.deepEqual(redactNodeData(data, []), data)
})

test("hides an API route's typed header value and returns its secret reference and header name", () => {
  const typed = { path: '/hook', methods: ['POST'], authHeader: 'X-Api-Key', authToken: 'placeholder-route' }
  assert.deepEqual(redactNodeData(typed, []), { ...typed, authToken: REDACTED })
  const referenced = { ...typed, authToken: 'secret:ROUTE_KEY' }
  assert.deepEqual(redactNodeData(referenced, []), referenced)
})

test('returns a <field>Secret property as it is: it names a secret', () => {
  const data = {
    registries: [{ host: 'registry.example.com', usernameSecret: 'REGISTRY_USER', passwordSecret: 'REGISTRY_PW' }],
    botTokenSecret: 'BOT_TOKEN',
    chatIdSecret: 'CHAT_ID',
  }
  assert.deepEqual(redactNodeData(data, []), data)
  assert.equal(findRedacted(redactNodeData(data, [])), undefined)
})

test('hides the value of a credential-named or scheme-carrying pair, keeps the rest', () => {
  const data = {
    headers: [
      { name: 'Authorization', value: 'placeholder' },
      { name: 'X-Upstream', value: 'Bearer placeholder' },
      { name: 'X-Api-Key', value: 'secret:MCP_KEY' },
      { name: 'Accept', value: 'application/json' },
    ],
  }
  assert.deepEqual(redactNodeData(data, []), {
    headers: [
      { name: 'Authorization', value: REDACTED },
      { name: 'X-Upstream', value: REDACTED },
      { name: 'X-Api-Key', value: 'secret:MCP_KEY' },
      { name: 'Accept', value: 'application/json' },
    ],
  })
})

test('judges an environment map by the variable name', () => {
  const env = {
    API_TOKEN: 'placeholder',
    AWS_SECRET_ACCESS_KEY: 'placeholder',
    DB_PASSWORD: 'placeholder',
    STORED: 'secret:DB_PW',
    HOST: 'db.example.com',
    PORT: '5432',
  }
  assert.deepEqual(redactNodeData({ env }, []), {
    env: { ...env, API_TOKEN: REDACTED, AWS_SECRET_ACCESS_KEY: REDACTED, DB_PASSWORD: REDACTED },
  })
})

test('hides the password of a URL anywhere in a string, and keeps the rest of it', () => {
  const data = {
    env: { DB_URL: 'postgresql://app:placeholder-pw@db.example.com/main' },
    note: 'see http://example.com',
  }
  assert.deepEqual(redactNodeData(data, []), {
    env: { DB_URL: `postgresql://app:${REDACTED}@db.example.com/main` },
    note: 'see http://example.com',
  })
})

test('hides a stored secret value wherever it appears', () => {
  const data = { command: 'run --key placeholder-stored-value' }
  assert.deepEqual(redactNodeData(data, ['placeholder-stored-value']), { command: `run --key ${REDACTED}` })
})

test('hides a stored secret value inside an encoding, by the text rules logs use', () => {
  const stored = 'placeholder-stored-value'
  const encoded = Buffer.from(`alice:${stored}`).toString('base64')
  assert.deepEqual(redactNodeData({ header: `Basic ${encoded}` }, [stored]), { header: `Basic ${REDACTED}` })
})

test('hides a typed value under a property the node type declares, and keeps its secret reference', () => {
  const declared = new Set(['proxyBasicAuth'])
  const typed = { proxyBasicAuth: 'alice:$apr1$placeholder', proxyBasicAuthUser: 'alice' }
  assert.deepEqual(redactNodeData(typed, [], declared), { ...typed, proxyBasicAuth: REDACTED })
  const referenced = { proxyBasicAuth: 'secret:PROXY_AUTH' }
  assert.deepEqual(redactNodeData(referenced, [], declared), referenced)
})

test('a property no type declares, under an ordinary name, is returned as it is', () => {
  const data = { proxyBasicAuth: 'alice:$apr1$placeholder' }
  assert.deepEqual(redactNodeData(data, []), data)
})

test('a stored identifier shorter than twelve characters leaves ordinary text alone', () => {
  const data = { repository: 'https://git.example.com/acme-corp/docker', mode: 'root' }
  assert.deepEqual(redactNodeData(data, ['acme-corp', 'root', 'eleven-char']), data)
  const twelve = 'twelve-chars'
  assert.deepEqual(redactNodeData({ command: `run ${twelve}` }, [twelve]), { command: `run ${REDACTED}` })
})

test('a longer stored value is hidden whole when a shorter one is inside it', () => {
  const data = { command: 'placeholder-long-value' }
  assert.deepEqual(redactNodeData(data, ['placeholder-', 'placeholder-long-value']), { command: REDACTED })
})

test('does not change the data it is given', () => {
  const data = { password: 'placeholder-pw' }
  redactNodeData(data, [])
  assert.equal(data.password, 'placeholder-pw')
})

test('finds the placeholder in a write, by path', () => {
  assert.equal(findRedacted({ headers: [{ name: 'Authorization', value: REDACTED }] }), 'headers.0.value')
  assert.equal(findRedacted(`Bearer ${REDACTED}`), '(value)')
  assert.equal(findRedacted({ headers: [{ name: 'Authorization', value: 'secret:KEY' }] }), undefined)
  assert.equal(findRedacted(undefined), undefined)
})

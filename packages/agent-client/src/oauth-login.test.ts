import assert from 'node:assert/strict'
import { test } from 'node:test'

import { extractOauthUrl, parseJsonRpcLines } from './oauth-login'

const URL_PATTERN = /https:\/\/accounts\.google\.com\/o\/oauth2\/[^\s"']+/

test('extractOauthUrl finds the consent URL inside TUI escape output', () => {
  const raw =
    '\u001b[?1049h\u001b[2J\u001b[HPlease visit the following URL to authorize the application:\n\n' +
    'https://accounts.google.com/o/oauth2/v2/auth?redirect_uri=https%3A%2F%2Fexample.com%2Fauthcode&code_challenge=abc123&state=xyz\n\n' +
    '\u001b[1G\u001b[0JEnter the authorization code: \u001b[31G'
  assert.equal(
    extractOauthUrl(raw, URL_PATTERN),
    'https://accounts.google.com/o/oauth2/v2/auth?redirect_uri=https%3A%2F%2Fexample.com%2Fauthcode&code_challenge=abc123&state=xyz',
  )
})

test('extractOauthUrl does not let an escape sequence bleed into the URL', () => {
  const raw = 'https://accounts.google.com/o/oauth2/v2/auth?state=abc\u001b[31Gmore'
  assert.equal(extractOauthUrl(raw, URL_PATTERN), 'https://accounts.google.com/o/oauth2/v2/auth?state=abc')
})

test('extractOauthUrl returns null when there is no consent URL', () => {
  assert.equal(extractOauthUrl('Enter the authorization code: ', URL_PATTERN), null)
})

test('parseJsonRpcLines picks JSON-RPC messages out of a mixed stream', () => {
  const raw = [
    'Loading harness...',
    '{"jsonrpc":"2.0","id":0,"result":{"protocolVersion":1}}',
    '{ this line is TUI noise, not JSON',
    '{"jsonrpc":"2.0","id":1,"error":{"message":"denied"}}',
    '{"jsonrpc":"2.0","method":"session/update",',
  ].join('\n')
  const messages = parseJsonRpcLines(raw)
  assert.equal(messages.length, 2)
  assert.deepEqual(messages[0], { jsonrpc: '2.0', id: 0, result: { protocolVersion: 1 } })
  assert.equal(messages[1].error?.message, 'denied')
})

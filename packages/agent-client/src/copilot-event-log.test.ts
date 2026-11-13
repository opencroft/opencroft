import assert from 'node:assert/strict'
import { appendFileSync, mkdirSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'

import { COPILOT_FAILURE_LOG, lastSessionError } from './copilot-event-log'

const line = (event: Record<string, unknown>) => `${JSON.stringify(event)}\n`
const sessionError = (data: Record<string, unknown>, id = 'error-1') => line({ type: 'session.error', data, id })

test('the last session.error in a slice is the failure, named from its errorType', () => {
  const slice =
    sessionError({ errorType: 'rate_limit', message: 'first', statusCode: 429 }, 'error-a') +
    line({ type: 'assistant.turn_start', data: {} }) +
    sessionError({ errorType: 'quota', message: 'Quota exceeded', statusCode: 402 }, 'error-b') +
    line({ type: 'session.shutdown', data: {} })
  assert.deepEqual(lastSessionError(slice), {
    reply: 'Error: Quota exceeded',
    failure: {
      id: 'error-b',
      label: 'quota_exhausted',
      kind: 'quota',
      title: 'The model quota is exhausted (HTTP 402)',
      category: 'limit',
      severity: 'error',
      details: 'Quota exceeded',
      actions: [],
    },
  })
})

test('an unreachable endpoint (errorType query, no status) is a generic model-call failure', () => {
  const message = 'Could not connect to local model provider at http://127.0.0.1:9/v1.'
  const found = lastSessionError(sessionError({ errorType: 'query', message }))
  assert.equal(found?.failure.label, 'service')
  assert.equal(found?.failure.title, 'The model call failed')
  assert.equal(found?.reply, `Error: ${message}`)
})

test('a slice cut mid-line, or without an error, or with an error missing its message, holds no failure', () => {
  const cut = '{"type":"session.error","data":{"errorType":"quota","mess'
  assert.equal(lastSessionError(`ge":"x"}}\n${line({ type: 'assistant.turn_end', data: {} })}${cut}`), undefined)
  assert.equal(lastSessionError(line({ type: 'assistant.turn_end', data: {} })), undefined)
  assert.equal(lastSessionError(sessionError({ errorType: 'quota' })), undefined)
})

test('the log is read from the mark taken at turn start, and a missing log or odd session id reads as nothing', (t) => {
  const home = mkdtempSync(join(tmpdir(), 'copilot-home-'))
  t.after(() => rmSync(home, { recursive: true, force: true }))
  const sessionId = '00000000-0000-4000-8000-000000000001'
  assert.equal(COPILOT_FAILURE_LOG.mark(home, sessionId), 0)
  assert.equal(COPILOT_FAILURE_LOG.read(home, sessionId, 0), undefined)

  const dir = join(home, 'session-state', sessionId)
  mkdirSync(dir, { recursive: true })
  const file = join(dir, 'events.jsonl')
  appendFileSync(file, sessionError({ errorType: 'authentication', message: 'earlier', statusCode: 401 }))
  const from = COPILOT_FAILURE_LOG.mark(home, sessionId)
  assert.ok(from > 0)
  assert.equal(COPILOT_FAILURE_LOG.read(home, sessionId, from), undefined, 'nothing logged since the mark')

  appendFileSync(file, sessionError({ errorType: 'authentication', message: 'now', statusCode: 401 }))
  assert.equal(COPILOT_FAILURE_LOG.read(home, sessionId, from)?.reply, 'Error: now')
  assert.equal(COPILOT_FAILURE_LOG.read(home, '../session-state', 0), undefined)
})

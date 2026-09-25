// A refusal leaves the server as data and arrives in the browser as the error
// the chat hook stops on; every other failure is left to throw as it did.
import assert from 'node:assert/strict'
import test from 'node:test'

import { ActionRequiredError } from 'agent-client/errors'

import {
  openedOrThrow,
  refusalAsData,
  SessionOpenRefusedError,
} from '@/app/_authed/(agent)/_shared/session-open-refusal'

const OPENED = { sessionId: 'session-1' }

test('an open that needs the reader to act answers with its message, as data', async () => {
  const answer = await refusalAsData(() => Promise.reject(new ActionRequiredError('Set a key first.')))
  // Plain data: exactly what crosses the wire, where a thrown error keeps only
  // its message and loses the class that says not to retry.
  assert.deepEqual(answer, { refused: 'Set a key first.' })
})

test('any other failure still throws, and a success passes through', async () => {
  await assert.rejects(
    refusalAsData(() => Promise.reject(new Error('harness would not start'))),
    /harness would not start/,
  )
  assert.equal(await refusalAsData(() => Promise.resolve(OPENED)), OPENED)
})

test('the transport side turns the refusal back into the error the hook stops on', () => {
  assert.throws(
    () => openedOrThrow({ refused: 'Set a key first.' }),
    (error: unknown) => error instanceof SessionOpenRefusedError && error.message === 'Set a key first.',
  )
  assert.equal(openedOrThrow(OPENED), OPENED)
})

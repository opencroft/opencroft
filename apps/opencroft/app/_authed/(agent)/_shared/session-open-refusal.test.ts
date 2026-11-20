// A refusal leaves the server as data and arrives in the browser as the error
// the chat hook stops on; every other failure is left to throw as it did.
import assert from 'node:assert/strict'
import test from 'node:test'

import { ActionRequiredError, HarnessStartError } from 'agent-client/errors'

import {
  OPEN_GAVE_UP_TITLE,
  openedOrThrow,
  openFailureNotice,
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

test('a harness that died at start is a refusal marked as the harness, not a failure to retry', async () => {
  const answer = await refusalAsData(() =>
    Promise.reject(new HarnessStartError('Agent failed to start (exit code 127): sh: 1: exec: npx: not found')),
  )
  assert.deepEqual(answer, {
    refused: 'Agent failed to start (exit code 127): sh: 1: exec: npx: not found',
    harnessExited: true,
  })
  assert.throws(
    () => openedOrThrow(answer),
    (error: unknown) => error instanceof SessionOpenRefusedError && error.kind === 'harness',
  )
})

test('a harness without Node.js reads in plain words, with the shell line under details', () => {
  const reason = 'Agent failed to start (exit code 127): sh: 1: exec: npx: not found'
  assert.deepEqual(openFailureNotice(reason, 'harness'), {
    title: "The agent couldn't start: Node.js isn't installed where it runs.",
    hint: 'Install Node.js (with npx) there, or put it on the PATH, then try again.',
    details: reason,
  })
})

test('a refusal is already written for the person and is the line itself, whatever words it shares with a rule', () => {
  for (const reason of [
    'GitHub Copilot does not accept classic personal access tokens (ghp_…): set a fine-grained token.',
    'Agent node not found',
    'Claude Code is not signed in: sign in to its account first, then start the session again.',
    "Node.js (npx) isn't available in terminal 'box'; install it there or put it on the non-interactive PATH.",
    'Codex needs an API key: set one on the agent profile (it is sent to the endpoint as a Bearer token).',
  ]) {
    assert.deepEqual(openFailureNotice(reason, 'refused'), { title: reason }, reason)
  }
})

test('a run that gave up on a socket error is told as given up, not as an unreachable model server', () => {
  // The open's own failure is the engine's, so the provider rules do not read it.
  assert.equal(openFailureNotice('connect ECONNREFUSED 10.0.0.5:8080', 'gave-up').title, OPEN_GAVE_UP_TITLE)
})

test('a harness failure no rule knows says the agent did not start, its text under details', () => {
  const notice = openFailureNotice('Agent failed to start (exit code 1): segfault', 'harness')
  assert.equal(notice.title, "The agent couldn't start.")
  assert.equal(notice.details, 'Agent failed to start (exit code 1): segfault')
})

test('a run of attempts that ran out says so, with the last failure under details', () => {
  assert.deepEqual(openFailureNotice('Internal Server Error', 'gave-up'), {
    title: OPEN_GAVE_UP_TITLE,
    hint: 'Try again once the server is back.',
    details: 'Internal Server Error',
  })
})

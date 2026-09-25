// The ask form against what codex-acp actually sends for request_user_input:
// its note field pairs with its question the way the host's own custom box
// does, its secret questions are typed masked, and the answer comes back under
// the keys codex-acp reads. The form itself, and where each part of it comes
// from in codex-acp, is in agent-client's elicitation-form.fixtures.

import assert from 'node:assert/strict'
import test from 'node:test'

import { questionsToElicitation } from 'agent-client/elicitation-form'
import { CODEX_USER_INPUT_FORM } from 'agent-client/elicitation-form.fixtures'
import type { ElicitationSchema } from 'agent-client/types'
import { renderToStaticMarkup } from 'react-dom/server'

import { AskUser, askFields, buildAskContent } from './ask-user'

const SCHEMA: ElicitationSchema = CODEX_USER_INPUT_FORM.requestedSchema
const noop = () => {}

function inputs(schema: ElicitationSchema): string[] {
  const html = renderToStaticMarkup(<AskUser schema={schema} onSubmit={noop} />)
  return html.match(/<input[^>]*>/g) ?? []
}

test('a codex note field folds into its question’s tab, and a secret question is marked secret', () => {
  const fields = askFields(SCHEMA)
  assert.deepEqual(
    fields.map((field) => ({
      key: field.key,
      type: field.kind.type,
      required: field.required,
      secret: field.secret,
      customKey: field.customKey,
      customSecret: field.customSecret,
    })),
    [
      {
        key: 'target',
        type: 'select',
        required: true,
        secret: undefined,
        customKey: 'target_note',
        customSecret: undefined,
      },
      { key: 'token', type: 'text', required: true, secret: true, customKey: undefined, customSecret: undefined },
    ],
  )
})

test('the answer uses the keys codex-acp reads: the question id, and the note under its own key', () => {
  const fields = askFields(SCHEMA)
  // Every question is required: nothing to send until both are answered.
  assert.equal(buildAskContent(fields, { values: { target: 'Staging' }, customs: {} }), null)
  assert.deepEqual(
    buildAskContent(fields, {
      values: { target: 'None of the above', token: 'tok-1' },
      customs: { target: ' the canary stack ' },
    }),
    { target: 'None of the above', target_note: 'the canary stack', token: 'tok-1' },
  )
  // The note alone answers its question, and still travels under its own key.
  assert.deepEqual(buildAskContent(fields, { values: { token: 'tok-1' }, customs: { target: 'the canary stack' } }), {
    target_note: 'the canary stack',
    token: 'tok-1',
  })
})

test('a note naming a question the form does not have stays a field of its own', () => {
  const { target: _target, ...orphaned } = SCHEMA.properties ?? {}
  const fields = askFields({ type: 'object', properties: orphaned })
  assert.deepEqual(
    fields.map((field) => field.key),
    ['target_note', 'token'],
  )
  // The same for the host encoder's own custom box.
  const host = questionsToElicitation([{ title: 'Approach', question: 'Which approach?', options: ['fast'] }])
  const { question_0: _question, ...hostOrphaned } = host.schema.properties ?? {}
  assert.deepEqual(
    askFields({ type: 'object', properties: hostOrphaned }).map((field) => field.key),
    ['question_0_custom'],
  )
})

test('a secret question renders a password input, an ordinary one does not', () => {
  const { token, target, target_note } = SCHEMA.properties ?? {}
  const [secret] = inputs({ type: 'object', properties: { token } })
  assert.match(secret, /type="password"/)
  assert.match(secret, /autoComplete="off"/)
  const plain = inputs({ type: 'object', properties: { target, target_note } })
  // The radio group's own hidden inputs aside, the note box is plain text.
  const note = plain.find((input) => /placeholder="Custom answer \(optional\)"/.test(input))
  assert.ok(note)
  assert.doesNotMatch(note, /type="password"/)
})

test('a secret note renders its own box as a password input', () => {
  const { target, target_note } = CODEX_USER_INPUT_FORM.requestedSchema.properties
  const secretNote = { ...target_note, _meta: { codex: { ...target_note._meta.codex, isSecret: true } } }
  const note = inputs({ type: 'object', properties: { target, target_note: secretNote } }).find((input) =>
    /placeholder="Custom answer \(optional\)"/.test(input),
  )
  assert.ok(note)
  assert.match(note, /type="password"/)
})

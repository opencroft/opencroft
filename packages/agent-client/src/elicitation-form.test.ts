import assert from 'node:assert/strict'
import test from 'node:test'

import { contentToAnswers, customAnswerTarget, isSecretField, questionsToElicitation } from './elicitation-form'
import { CLAUDE_ASK_USER_QUESTION_FORM, CODEX_USER_INPUT_FORM } from './elicitation-form.fixtures'

const QUESTIONS = [
  { title: 'Approach', question: 'Which approach?', options: ['fast', 'thorough'] },
  { title: 'Scope', question: 'Which parts?', options: ['engine', 'ui'], multiple: true },
]

test('a single question puts its text in the message and skips per-field descriptions', () => {
  const { message, schema } = questionsToElicitation([QUESTIONS[0]])
  assert.equal(message, 'Which approach?')
  const field = schema.properties?.question_0 as { description?: string }
  assert.equal(field.description, undefined)
})

test('several questions carry their text per field, options become titled enums', () => {
  const { message, schema } = questionsToElicitation(QUESTIONS)
  assert.equal(message, 'Please answer the following questions.')
  const first = schema.properties?.question_0 as { type: string; description?: string; oneOf?: unknown[] }
  assert.equal(first.type, 'string')
  assert.equal(first.description, 'Which approach?')
  assert.deepEqual(first.oneOf, [
    { const: 'fast', title: 'fast' },
    { const: 'thorough', title: 'thorough' },
  ])
  const second = schema.properties?.question_1 as { type: string }
  assert.equal(second.type, 'array')
  // Every question gets its own optional custom box; nothing is required.
  assert.ok(schema.properties?.question_0_custom)
  assert.ok(schema.properties?.question_1_custom)
  assert.equal(schema.required, undefined)
})

test('contentToAnswers folds picks and customs back under the question titles', () => {
  const answers = contentToAnswers(QUESTIONS, {
    question_0: 'fast',
    question_1: ['engine', 'ui'],
    question_1_custom: 'docs too',
  })
  assert.deepEqual(answers, { Approach: 'fast', Scope: 'engine, ui, docs too' })
})

test('an unanswered question folds to an empty string, a custom alone stands in for picks', () => {
  const answers = contentToAnswers(QUESTIONS, { question_0_custom: 'my own way' })
  assert.deepEqual(answers, { Approach: 'my own way', Scope: '' })
})

test('customAnswerTarget pairs the encoder’s custom box and codex-acp’s note field alike', () => {
  const { schema } = questionsToElicitation(QUESTIONS)
  const properties = schema.properties ?? {}
  assert.equal(customAnswerTarget('question_0_custom', properties.question_0_custom), 'question_0')
  assert.equal(customAnswerTarget('question_0', properties.question_0), null)

  const codex = CODEX_USER_INPUT_FORM.requestedSchema.properties
  assert.equal(customAnswerTarget('target_note', codex.target_note), 'target')
  assert.equal(customAnswerTarget('target', codex.target), null)
  assert.equal(customAnswerTarget('token', codex.token), null)
  // A codex field in any other role is not a note, questionId or not.
  assert.equal(customAnswerTarget('other', { type: 'string', _meta: { codex: { questionId: 'target' } } }), null)
})

test('customAnswerTarget pairs an unmarked question_<n>_custom box by its key alone', () => {
  const claude = CLAUDE_ASK_USER_QUESTION_FORM.requestedSchema.properties
  assert.equal(customAnswerTarget('question_0_custom', claude.question_0_custom), 'question_0')
  assert.equal(customAnswerTarget('question_1_custom', claude.question_1_custom), 'question_1')
  assert.equal(customAnswerTarget('question_0', claude.question_0), null)
  // Only the bridge's exact key shape pairs; another `_custom` suffix is a field of its own.
  assert.equal(customAnswerTarget('color_custom', { type: 'string' }), null)
  assert.equal(customAnswerTarget('question_x_custom', { type: 'string' }), null)
})

test('isSecretField reads codex-acp’s isSecret, and nothing else marks a field secret', () => {
  const codex = CODEX_USER_INPUT_FORM.requestedSchema.properties
  assert.equal(isSecretField(codex.token), true)
  assert.equal(isSecretField(codex.target), false)
  assert.equal(isSecretField(codex.target_note), false)
  assert.equal(isSecretField({ type: 'string', _meta: { codex: { isSecret: 'yes' } } }), false)
  assert.equal(isSecretField({ type: 'string' }), false)
})

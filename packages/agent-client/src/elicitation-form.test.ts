import assert from 'node:assert/strict'
import test from 'node:test'

import { contentToAnswers, questionsToElicitation } from './elicitation-form'

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

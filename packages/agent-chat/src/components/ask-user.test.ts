import assert from 'node:assert/strict'
import test from 'node:test'

import { questionsToElicitation } from 'agent-client/elicitation-form'
import { CLAUDE_ASK_USER_QUESTION_FORM } from 'agent-client/elicitation-form.fixtures'
import type { ElicitationSchema } from 'agent-client/types'

import { askFields, buildAskContent } from './ask-user'

const SCHEMA: ElicitationSchema = {
  type: 'object',
  properties: {
    choice: {
      type: 'string',
      title: 'Choice',
      oneOf: [
        { const: 'a', title: 'Option A' },
        { const: 'b', title: 'Option B', description: 'the other one' },
      ],
    },
    tags: { type: 'array', title: 'Tags', items: { type: 'string', enum: ['x', 'y'] } },
    confirm: { type: 'boolean', title: 'Confirm' },
    count: { type: 'integer', title: 'Count' },
    note: { type: 'string', title: 'Note' },
  },
  required: ['choice'],
}

test('askFields folds each ACP property type into its renderable shape', () => {
  const fields = askFields(SCHEMA)
  assert.deepEqual(
    fields.map((field) => [field.key, field.kind.type, field.required]),
    [
      ['choice', 'select', true],
      ['tags', 'multi', false],
      ['confirm', 'boolean', false],
      ['count', 'number', false],
      ['note', 'text', false],
    ],
  )
  const choice = fields[0]
  assert.equal(choice.kind.type, 'select')
  if (choice.kind.type === 'select') {
    // Wire value and display label stay apart: the answer carries the const.
    assert.deepEqual(choice.kind.options[0], { value: 'a', label: 'Option A' })
    assert.equal(choice.kind.options[1].description, 'the other one')
  }
})

test('a custom-answer field folds into its question tab instead of becoming one', () => {
  const { schema } = questionsToElicitation([
    { title: 'Approach', question: 'Which approach?', options: ['fast', 'thorough'] },
    { title: 'Scope', question: 'Which parts?', options: ['engine', 'ui'], multiple: true },
  ])
  const fields = askFields(schema)
  // Four schema properties, two tabs — each custom box attached to its owner.
  assert.deepEqual(
    fields.map((field) => [field.key, field.customKey]),
    [
      ['question_0', 'question_0_custom'],
      ['question_1', 'question_1_custom'],
    ],
  )
  assert.equal(fields[0].kind.type, 'select')
  assert.equal(fields[1].kind.type, 'multi')
})

test('an unmarked question_<n>_custom box from claude-agent-acp folds into its question tab', () => {
  const fields = askFields(CLAUDE_ASK_USER_QUESTION_FORM.requestedSchema)
  assert.deepEqual(
    fields.map((field) => [field.key, field.kind.type, field.customKey]),
    [
      ['question_0', 'select', 'question_0_custom'],
      ['question_1', 'multi', 'question_1_custom'],
    ],
  )
  // The typed text answers under the box's own key, where the adapter reads it.
  assert.deepEqual(
    buildAskContent(fields, {
      values: { question_0: 'Fast', question_1: ['UI'] },
      customs: { question_0: 'but carefully', question_1: 'docs' },
    }),
    { question_0: 'Fast', question_0_custom: 'but carefully', question_1: ['UI'], question_1_custom: 'docs' },
  )
})

test('a question_<n>_custom field whose question is missing stays a tab of its own', () => {
  const fields = askFields({
    type: 'object',
    properties: { question_3_custom: { type: 'string', title: 'Other' } },
  })
  assert.deepEqual(
    fields.map((field) => [field.key, field.kind.type]),
    [['question_3_custom', 'text']],
  )
})

test('an unknown property type degrades to a text input rather than vanishing', () => {
  const fields = askFields({
    type: 'object',
    properties: { odd: { type: '_vendor/custom' } as never },
  })
  assert.equal(fields[0].kind.type, 'text')
})

test('buildAskContent gates on required fields and types each answer', () => {
  const fields = askFields(SCHEMA)
  // Required `choice` unanswered → no content, whatever else is filled.
  assert.equal(buildAskContent(fields, { values: { note: 'hi' }, customs: {} }), null)
  assert.deepEqual(buildAskContent(fields, { values: { choice: 'a' }, customs: {} }), {
    choice: 'a',
    confirm: false,
  })
  assert.deepEqual(
    buildAskContent(fields, {
      values: { choice: 'b', tags: ['x'], confirm: true, count: '3', note: ' hi ' },
      customs: {},
    }),
    { choice: 'b', tags: ['x'], confirm: true, count: 3, note: 'hi' },
  )
})

test('buildAskContent rejects a non-numeric or fractional answer to an integer field', () => {
  const fields = askFields(SCHEMA)
  assert.equal(buildAskContent(fields, { values: { choice: 'a', count: 'many' }, customs: {} }), null)
  assert.equal(buildAskContent(fields, { values: { choice: 'a', count: '1.5' }, customs: {} }), null)
})

test('a custom answer travels under its own key and satisfies a required question by itself', () => {
  const { schema } = questionsToElicitation([
    { title: 'Approach', question: 'Which approach?', options: ['fast', 'thorough'] },
  ])
  // The bridge convention marks nothing required, but pin the behavior for a
  // schema that does: the custom box answers for its question.
  schema.required = ['question_0']
  const fields = askFields(schema)
  assert.equal(buildAskContent(fields, { values: {}, customs: {} }), null)
  assert.deepEqual(buildAskContent(fields, { values: {}, customs: { question_0: 'my own way' } }), {
    question_0_custom: 'my own way',
  })
  assert.deepEqual(
    buildAskContent(fields, { values: { question_0: 'fast' }, customs: { question_0: 'but carefully' } }),
    { question_0: 'fast', question_0_custom: 'but carefully' },
  )
})

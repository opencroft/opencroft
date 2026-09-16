import assert from 'node:assert/strict'
import test from 'node:test'

import type { ElicitationSchema } from 'agent-client/types'

import { buildFormContent, formFields } from './ask-form'

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

test('formFields folds each ACP property type into its renderable shape', () => {
  const fields = formFields(SCHEMA)
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

test('an unknown property type degrades to a text input rather than vanishing', () => {
  const fields = formFields({
    type: 'object',
    properties: { odd: { type: '_vendor/custom' } as never },
  })
  assert.equal(fields[0].kind.type, 'text')
})

test('buildFormContent gates on required fields and types each answer', () => {
  const fields = formFields(SCHEMA)
  // Required `choice` unanswered → no content, whatever else is filled.
  assert.equal(buildFormContent(fields, { note: 'hi' }), null)
  assert.deepEqual(buildFormContent(fields, { choice: 'a' }), { choice: 'a', confirm: false })
  assert.deepEqual(
    buildFormContent(fields, { choice: 'b', tags: ['x'], confirm: true, count: '3', note: ' hi ' }),
    { choice: 'b', tags: ['x'], confirm: true, count: 3, note: 'hi' },
  )
})

test('buildFormContent rejects a non-numeric or fractional answer to an integer field', () => {
  const fields = formFields(SCHEMA)
  assert.equal(buildFormContent(fields, { choice: 'a', count: 'many' }), null)
  assert.equal(buildFormContent(fields, { choice: 'a', count: '1.5' }), null)
})

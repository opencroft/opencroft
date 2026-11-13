// Password managers, the browser's own and the extensions, take a
// password-type field for a login: they offer saved passwords in it and offer
// to save what is typed. A field holding a secret value is therefore a text
// field drawn as dots, with the attributes the managers read to stay away.

import assert from 'node:assert/strict'
import test from 'node:test'

import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'

import { SecretValueField, SecretValueInput, type SecretValueInputProps } from './secret-value-field'

const noop = () => {}

function textField(markup: string): string {
  const inputs = markup.match(/<input[^>]*>/g) ?? []
  assert.equal(inputs.length, 1, 'the field draws one input')
  return inputs[0]
}

function renderInput(props: Partial<SecretValueInputProps>): string {
  return textField(
    renderToStaticMarkup(
      createElement(SecretValueInput, { value: { value: 'sk-1' }, secrets: [], onCommit: noop, ...props }),
    ),
  )
}

test('a concealed field is a text field drawn as dots', () => {
  const input = renderInput({ concealed: true })
  assert.match(input, /type="text"/)
  assert.doesNotMatch(input, /type="password"/)
  assert.match(input, /\[-webkit-text-security:disc\]/)
})

test('a field that is not concealed shows its text', () => {
  const input = renderInput({})
  assert.match(input, /type="text"/)
  assert.doesNotMatch(input, /-webkit-text-security/)
})

test('a field tells password managers and spelling to leave it alone', () => {
  for (const concealed of [true, false]) {
    const input = renderInput({ concealed })
    for (const attribute of [
      'autocomplete="off"',
      'autocorrect="off"',
      'autocapitalize="off"',
      'spellcheck="false"',
      'data-1p-ignore="true"',
      'data-lpignore="true"',
      'data-bwignore="true"',
      'data-form-type="other"',
    ]) {
      // HTML attribute names are case-insensitive; React writes them as named in JSX.
      assert.ok(input.toLowerCase().includes(attribute), `${attribute} on ${input}`)
    }
  }
})

test('a labelled concealed field is a text field drawn as dots', () => {
  const input = textField(
    renderToStaticMarkup(
      createElement(SecretValueField, {
        label: 'API key',
        value: { value: 'sk-1' },
        secrets: [],
        onChange: noop,
        concealed: true,
      }),
    ),
  )
  assert.match(input, /type="text"/)
  assert.match(input, /\[-webkit-text-security:disc\]/)
})

import assert from 'node:assert/strict'
import test from 'node:test'

import type { ModelMessage } from 'ai'

import { transcriptText } from './native-compaction'
import { requestMessages, toolImagesAfterResults, withoutToolImages } from './tool-images'
import { toolAnswer, toolModelOutput } from './tool-result'

// A picture's base64 here is a stand-in: nothing decodes it, and its length is
// what the size line is computed from (8 characters, 6 bytes).
const PIXELS = 'AAAAAAAA'

function pictureResult(toolCallId: string, text: string, data = PIXELS) {
  return {
    type: 'tool-result' as const,
    toolCallId,
    toolName: 'view',
    output: toolModelOutput({
      content: [
        { type: 'text', text },
        { type: 'image', data, mimeType: 'image/png' },
      ],
    }),
  }
}

const call = (toolCallId: string) => ({ type: 'tool-call' as const, toolCallId, toolName: 'view', input: {} })

test('a result with no picture is the flattened text, as both the answer and the model output', () => {
  const envelope = {
    content: [
      { type: 'text', text: 'one' },
      { type: 'text', text: 'two' },
    ],
  }
  assert.equal(toolAnswer(envelope), 'one\ntwo')
  assert.deepEqual(toolModelOutput(toolAnswer(envelope)), { type: 'text', value: 'one\ntwo' })
  assert.equal(toolAnswer('plain'), 'plain')
})

test('a result with a picture keeps it in place among the text', () => {
  const envelope = {
    content: [
      { type: 'text', text: 'before' },
      { type: 'image', data: PIXELS, mimeType: 'image/png' },
      { type: 'text', text: 'after' },
    ],
  }
  assert.equal(toolAnswer(envelope), envelope)
  assert.deepEqual(toolModelOutput(envelope), {
    type: 'content',
    value: [
      { type: 'text', text: 'before' },
      { type: 'image-data', data: PIXELS, mediaType: 'image/png' },
      { type: 'text', text: 'after' },
    ],
  })
})

test('a conversation without pictures is returned as it is, for every API and either kind of model', () => {
  const messages: ModelMessage[] = [
    { role: 'user', content: 'hi' },
    { role: 'assistant', content: [call('a')] },
    { role: 'tool', content: [{ type: 'tool-result', toolCallId: 'a', toolName: 'view', output: { type: 'text', value: 'x' } }] },
  ]
  for (const api of ['chat-completions', 'responses', 'anthropic-messages'] as const) {
    assert.equal(requestMessages(api, messages, true), messages)
    assert.equal(requestMessages(api, messages, false), messages)
  }
})

test('on the APIs that carry pictures inside a tool result the stored form is sent as it is', () => {
  const messages: ModelMessage[] = [
    { role: 'assistant', content: [call('a')] },
    { role: 'tool', content: [pictureResult('a', 'one')] },
  ]
  assert.equal(requestMessages('responses', messages, true), messages)
  assert.equal(requestMessages('anthropic-messages', messages, true), messages)
  assert.equal(requestMessages('chat-completions', messages, true).length, 3)
  for (const api of ['chat-completions', 'responses', 'anthropic-messages'] as const) {
    assert.deepEqual(requestMessages(api, messages, false), withoutToolImages(messages))
  }
})

test('results split over consecutive tool messages get one picture message, after the last, in call order', () => {
  const messages: ModelMessage[] = [
    { role: 'user', content: 'look' },
    { role: 'assistant', content: [call('first'), call('second')] },
    { role: 'tool', content: [pictureResult('second', 'two', 'SECOND==')] },
    { role: 'tool', content: [pictureResult('first', 'one', 'FIRST===')] },
    { role: 'assistant', content: 'seen' },
  ]
  const shaped = toolImagesAfterResults(messages)
  assert.deepEqual(
    shaped.map((message) => message.role),
    ['user', 'assistant', 'tool', 'tool', 'user', 'assistant'],
  )
  const pictureMessage = shaped[4]
  assert.ok(pictureMessage.role === 'user' && Array.isArray(pictureMessage.content))
  assert.deepEqual(
    pictureMessage.content.map((part) => (part.type === 'image' ? part.image : part.type)),
    ['text', 'FIRST===', 'SECOND=='],
  )
  // The stored conversation is not rewritten.
  assert.equal(messages.length, 5)
  assert.equal((messages[2] as { content: { output: { type: string } }[] }).content[0].output.type, 'content')
})

test('the picture message follows the call order, not the order the results settled in', () => {
  const shaped = toolImagesAfterResults([
    { role: 'assistant', content: [call('first'), call('second')] },
    {
      role: 'tool',
      content: [
        { ...pictureResult('second', 'two'), output: toolModelOutput({ content: [{ type: 'image', data: 'BBBB', mimeType: 'image/jpeg' }] }) },
        pictureResult('first', 'one'),
      ],
    },
  ])
  const pictures = shaped[2].content as { type: string; mediaType?: string }[]
  assert.deepEqual(
    pictures.map((part) => part.mediaType),
    [undefined, 'image/png', 'image/jpeg'],
  )
})

test('for a model without image input each picture becomes a line and no message is added', () => {
  const messages: ModelMessage[] = [
    { role: 'assistant', content: [call('a')] },
    { role: 'tool', content: [pictureResult('a', 'one')] },
  ]
  const shaped = withoutToolImages(messages)
  assert.equal(shaped.length, 2)
  assert.deepEqual((shaped[1] as { content: { output: unknown }[] }).content[0].output, {
    type: 'text',
    value: 'one\n[image image/png, 6 B, not shown: this model does not take images]',
  })
})

test('the compaction transcript names a picture and never carries its bytes', () => {
  const text = transcriptText([
    { role: 'assistant', content: [call('a')] },
    { role: 'tool', content: [pictureResult('a', 'shot.png')] },
  ])
  assert.match(text, /\[tool view returned: shot\.png\n\[image image\/png, 6 B\]\]/)
  assert.doesNotMatch(text, new RegExp(PIXELS))
})

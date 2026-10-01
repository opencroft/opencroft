import assert from 'node:assert/strict'
import test from 'node:test'

import type { ContentBlock } from '@agentclientprotocol/sdk'

import { blockBytes, promptBudget } from './prompt-size'

const text: ContentBlock = { type: 'text', text: 'hi' }
const image = (name: string, size: number) => ({
  name,
  block: { type: 'image', data: 'A'.repeat(size), mimeType: 'image/png' } satisfies ContentBlock,
})

test('the measure is the serialized block and its comma, in UTF-8 bytes', () => {
  assert.equal(blockBytes(text), JSON.stringify(text).length + 1)
  // Two bytes each in UTF-8, one UTF-16 unit each in the string.
  assert.equal(blockBytes({ type: 'text', text: 'éé' }), JSON.stringify({ type: 'text', text: '' }).length + 4 + 1)
})

test('blocks are counted in while they fit, and one that would cross the budget is refused', () => {
  const a = image('a', 100).block
  const b = image('b', 1000).block
  const budget = blockBytes(text) + blockBytes(a) + 200
  const prompt = promptBudget(text, budget)
  assert.equal(prompt.textFits, true)
  assert.equal(prompt.take(a), true)
  assert.equal(prompt.take(b), false)
  assert.equal(prompt.take(image('c', 10).block), true, 'a refused block took nothing from what is left')
})

test('a block that lands exactly on the budget fits', () => {
  const a = image('a', 100).block
  assert.equal(promptBudget(text, blockBytes(text) + blockBytes(a)).take(a), true)
})

test('a text over the budget on its own does not fit', () => {
  assert.equal(promptBudget(text, blockBytes(text) - 1).textFits, false)
  assert.equal(promptBudget(text, blockBytes(text)).textFits, true)
})

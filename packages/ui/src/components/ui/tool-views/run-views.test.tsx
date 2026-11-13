import assert from 'node:assert/strict'
import { test } from 'node:test'

import { renderToStaticMarkup } from 'react-dom/server'

import { AskUserQuestionView } from './run-views'

const text = (html: string) => html.replace(/<[^>]*>/g, '')
const call = { tool: 'AskUserQuestion', requestId: 'call-1', mode: 'history' } as const

test('a question call that ends before its arguments arrive names the question without a count', () => {
  for (const [state, word] of [
    ['cancelled', 'stopped'],
    ['failed', 'failed'],
  ] as const) {
    const shown = text(renderToStaticMarkup(<AskUserQuestionView {...call} args={{}} state={state} />))
    assert.ok(shown.includes('Ask question'), shown)
    assert.ok(shown.includes(word), shown)
    assert.ok(!/\d+ questions?/.test(shown), shown)
  }
})

test('a call that asked several questions still gives their count', () => {
  const args = { questions: [{ question: 'First?' }, { question: 'Second?' }] }
  const shown = text(renderToStaticMarkup(<AskUserQuestionView {...call} args={args} state='cancelled' />))
  assert.ok(shown.includes('Ask 2 questions'), shown)
})

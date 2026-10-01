import assert from 'node:assert/strict'
import test from 'node:test'

import type { ChatMessage } from 'agent-client/fold'
import { renderToStaticMarkup } from 'react-dom/server'

import { TurnDetails } from './turn-details'

// The same collapse rule as the kit turn's, on the MessageView path: the last
// text, then what came after it that the reader still needs, in order.

function collapsed(items: ChatMessage[]): string {
  return renderToStaticMarkup(
    <TurnDetails
      items={items}
      toolViews={{}}
      botName='agent-a'
      defaultCollapsed
      onRespondPermission={() => {}}
      onRespondAsk={() => {}}
    />,
  )
}

test('a collapsed turn keeps the notices after its last text, in order, and folds the ones before it', () => {
  const markup = collapsed([
    { id: '1', kind: 'notice', severity: 'warning', title: 'Early notice' },
    { id: '2', kind: 'assistant', text: 'Final reply' },
    { id: '3', kind: 'tool', toolCallId: 'c1', title: 'run_tool', status: 'completed' },
    { id: '4', kind: 'notice', severity: 'error', title: 'Hook blocked the turn' },
  ])
  assert.ok(!markup.includes('Early notice'), 'a notice the reply came after folds away with the rest')
  const reply = markup.indexOf('Final reply')
  const tool = markup.indexOf('run_tool')
  const notice = markup.indexOf('Hook blocked the turn')
  assert.ok(reply >= 0 && tool > reply && notice > tool, `in order: ${reply}, ${tool}, ${notice}`)
})

test('a collapsed turn with no text keeps its last entry and every notice', () => {
  const markup = collapsed([
    { id: '1', kind: 'tool', toolCallId: 'c1', title: 'first_tool', status: 'completed' },
    { id: '2', kind: 'notice', severity: 'info', title: 'Task stopped by user' },
    { id: '3', kind: 'tool', toolCallId: 'c2', title: 'last_tool', status: 'completed' },
  ])
  assert.ok(markup.includes('Task stopped by user'))
  assert.ok(markup.includes('last_tool'))
  assert.ok(!markup.includes('first_tool'))
})

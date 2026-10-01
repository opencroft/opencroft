import assert from 'node:assert/strict'
import test from 'node:test'

import type { ReactNode } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'

import { ChatTurnDetails, type ChatTurnRenderers, type DetailItem } from './chat-turn'

// What a collapsed reply chain keeps. Collapsed shows the last text and what
// came after it that the reader still needs: the tool call it ended on, and
// every notice. A notice after the reply is usually the turn's outcome (a hook
// that blocked it), so folding it away would read as a normal reply.

const renderers = {
  Chained: ({ children }: { marker: ReactNode; children: ReactNode }) => <div>{children}</div>,
  ChainDot: () => <span />,
  ThinkingBlock: ({ text }: { text: string }) => <div>{text}</div>,
} as unknown as ChatTurnRenderers

function collapsed(items: DetailItem[]): string {
  return renderToStaticMarkup(
    <ChatTurnDetails
      blockId='b1'
      botName='agent-a'
      items={items}
      defaultCollapsed
      renderTool={(item) => <div>{`tool:${item.name}`}</div>}
      renderers={renderers}
    />,
  )
}

test('a collapsed turn keeps the notices after its last text, in order, and folds the ones before it', () => {
  const markup = collapsed([
    { kind: 'notice', severity: 'warning', title: 'Early notice' },
    { kind: 'assistant-text', text: 'Earlier reply' },
    { kind: 'assistant-text', text: 'Final reply' },
    { kind: 'tool', id: 't1', name: 'run', args: {} },
    { kind: 'notice', severity: 'error', title: 'Hook blocked the turn' },
  ])
  assert.ok(markup.includes('Final reply'))
  assert.ok(!markup.includes('Early notice'), 'a notice the reply came after folds away with the rest')
  const reply = markup.indexOf('Final reply')
  const tool = markup.indexOf('tool:run')
  const notice = markup.indexOf('Hook blocked the turn')
  assert.ok(reply >= 0 && tool > reply && notice > tool, `in order: ${reply}, ${tool}, ${notice}`)
})

test('a collapsed turn with no text keeps its last entry and every notice', () => {
  const markup = collapsed([
    { kind: 'tool', id: 't1', name: 'first', args: {} },
    { kind: 'notice', severity: 'info', title: 'Task stopped by user' },
    { kind: 'tool', id: 't2', name: 'last', args: {} },
  ])
  assert.ok(markup.includes('Task stopped by user'))
  assert.ok(markup.includes('tool:last'))
  assert.ok(!markup.includes('tool:first'))
})

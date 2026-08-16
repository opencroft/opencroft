import { type ChatMessage, isTerminalToolStatus } from 'agent-client/fold'

import type { Block } from './components/chat-conversation'
import type { DetailItem, UserText } from './components/chat-turn'
import { formatToolValue } from './tool-views'

// Re-exported rather than redeclared: the component that renders these is what
// defines their shape, so there is exactly one definition of each. A second one
// here would drift the moment either side changed on its own.
export type { Block, DetailItem, UserText }

// Group a folded transcript into the blocks the installed conversation renders:
// a user message is its own block, and every reply until the next user message
// collapses into one details block.
//
// This is the seam between the two block vocabularies in play. The client's
// fold produces a flat message log; the kit conversation wants user/details
// blocks. A host with its own message pipeline (one that strips app-specific
// tags out of a prompt before it renders, say) builds its own instead — this is
// the plain version for a host that has no such pipeline.
//
// Ids name the block for React and must survive a re-fold of the same log, so
// they come from the message the block starts at rather than its position.
export function buildKitBlocks(messages: readonly ChatMessage[]): Block[] {
  const blocks: Block[] = []
  let details: DetailItem[] = []
  // The reply this run of details started at — the run's name.
  let runId: string | null = null

  const flush = () => {
    if (details.length > 0 && runId !== null) {
      blocks.push({ id: `t:${runId}`, kind: 'details', items: details })
    }
    details = []
    runId = null
  }

  for (const message of messages) {
    if (message.kind === 'user') {
      flush()
      // A message that renders nothing still ends the run above it, so the
      // flush happens before this check rather than after.
      if (message.text.trim()) {
        blocks.push({ id: `u:${message.id}`, kind: 'user', text: message.text as UserText })
      }
      continue
    }
    if (runId === null) {
      runId = message.id
    }
    switch (message.kind) {
      case 'assistant':
        if (message.text.trim()) {
          details.push({ kind: 'assistant-text', text: message.text })
        }
        break
      case 'thought':
        if (message.text.trim()) {
          details.push({ kind: 'thinking', text: message.text })
        }
        break
      case 'tool':
        details.push({
          kind: 'tool',
          id: message.toolCallId,
          name: message.title,
          args: message.input,
          // A call that hasn't produced output yet has no result at all, which
          // is how the renderer tells "still running" from "returned nothing".
          result:
            isTerminalToolStatus(message.status) || message.output !== undefined
              ? { text: formatToolValue(message.output), isError: message.status === 'failed' }
              : undefined,
        })
        break
      case 'error':
        // The kit turn has no error item of its own. Dropping it would lose the
        // only report the reader gets of a turn that failed, so it renders as
        // assistant text rather than not at all.
        details.push({ kind: 'assistant-text', text: message.text })
        break
      default:
        // 'permission' and 'ask' are answered by <Approvals>, beside the
        // conversation rather than inside it. 'plan' has no kit equivalent yet.
        break
    }
  }
  flush()
  return blocks
}

// How much one prompt may carry over the wire.
//
// ACP's TypeScript SDK reads its peer line by line and refuses any single line
// over DEFAULT_MAX_MESSAGE_BYTES (32 MiB in @agentclientprotocol/sdk 1.5.x,
// stream-limits.js). The refusal does not drop that one message: it errors the
// whole readable stream, so the connection closes and the bridge process shuts
// down with it (claude-agent-acp exits on `connection.closed`). What decides
// the limit is the RECEIVING side's SDK, which is the bridge's and not ours, so
// the figure is held here rather than read from the SDK this package installs.
//
// A prompt is one JSON-RPC request on one line, and the images in it travel as
// base64, so a handful of large ones is enough to cross it. The budget sits a
// margin under the limit: the request's envelope (jsonrpc, id, method, the
// session id, a steer's delivery note and `_meta`) is not measured block by
// block, and a megabyte covers it with room to spare.

import type { ContentBlock } from '@agentclientprotocol/sdk'

/** The largest line the bridge's SDK reads before it closes the connection. */
export const ACP_MAX_MESSAGE_BYTES = 32 * 1024 * 1024

/** What the prompt's blocks may take together, leaving room for the envelope. */
export const PROMPT_BLOCK_BUDGET = ACP_MAX_MESSAGE_BYTES - 1024 * 1024

/** The bytes one block adds to the serialized prompt array, its comma included. */
export function blockBytes(block: ContentBlock): number {
  return Buffer.byteLength(JSON.stringify(block), 'utf8') + 1
}

/**
 * A prompt's running size against the budget, text first.
 *
 * Kept as a running total rather than measured once over a finished list, so
 * the caller can decide each image as it reads it, and stop reading at the
 * first that does not fit: the bytes past the budget are never fetched at all.
 */
export function promptBudget(text: ContentBlock, budget = PROMPT_BLOCK_BUDGET) {
  let used = blockBytes(text)
  return {
    /** Whether the text alone is within the budget. Nothing can go when it is not. */
    textFits: used <= budget,
    /** Counts the block in when it fits, and says whether it did. */
    take(block: ContentBlock): boolean {
      const next = used + blockBytes(block)
      if (next > budget) {
        return false
      }
      used = next
      return true
    },
  }
}

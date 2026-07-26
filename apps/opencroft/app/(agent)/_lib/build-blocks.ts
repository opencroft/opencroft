import type { ChatMessage } from '@/app/(agent)/_lib/messages'

export type DetailItem =
  | { kind: 'assistant-text'; text: string }
  | { kind: 'thinking'; text: string }
  | { kind: 'tool'; id: string; name: string; args: unknown; result?: { text: string; isError?: boolean } }

// `id` is the React key, and it has to name the same block before and after a
// "load older" prepend — otherwise React rewrites DOM across the visible range
// and the scroll restore loses the element it measures against.
//
// A user block is named by its own message. A details block is named by the
// TURN it belongs to, not by whichever message happens to be first in the
// loaded slice: pages can land mid-turn, and consecutive agent messages fold
// into one block, so a page merging into the block above would otherwise rename
// it on every fetch. Naming it by the turn was always the honest identity — a
// details block *is* one turn's replies — and it only looked stable before
// because every page began at a turn boundary.
//
// The two namespaces are prefixed because a turn's identity is its own user
// message's id, so the bare numbers would collide between the two kinds.
export type Block = { id: string; kind: 'user'; text: string } | { id: string; kind: 'details'; items: DetailItem[] }

export function stripOpencroftTags(text: string): string {
  return text.replace(/<opencroft-[a-z0-9-]+>[\s\S]*?<\/opencroft-[a-z0-9-]+>\s*/gi, '')
}

// `enclosingTurnId` names the turn the FIRST run of replies belongs to, for a
// window that starts mid-turn — that turn's own user message sits above the
// loaded slice, so nothing here can derive it. It is load-bearing rather than
// cosmetic: the leading run is precisely the block that absorbs each mid-turn
// page, so without it that block is renamed on every fetch and the restore
// loses its anchor. Callers pass the `header` the window carries for exactly
// this purpose.
export function buildBlocks(messages: ChatMessage[], enclosingTurnId?: number): Block[] {
  const blocks: Block[] = []
  let details: DetailItem[] = []
  // The turn the current run of replies belongs to. Seeded with the enclosing
  // turn so a mid-turn window's leading run is named correctly.
  let turnId: number | null = enclosingTurnId ?? null
  // Only used when no turn is known at all: a log whose first loaded reply has
  // no user message above it anywhere. That can only be the true start of
  // history, where `hasMore` is false and nothing can be prepended, so naming
  // the block after its first message is stable by circumstance. Ids are
  // absolute event indices, so this cannot collide with a turn-named block.
  let firstReplyId: number | null = null
  const flush = () => {
    const id = turnId ?? firstReplyId
    if (details.length === 0 || id === null) {
      return
    }
    blocks.push({ id: `t:${id}`, kind: 'details', items: details })
    details = []
    firstReplyId = null
  }
  for (const m of messages) {
    if (m.role === 'user') {
      flush()
      // The turn boundary exists even when the message renders nothing (its
      // text can strip to empty), so the replies below still belong to it.
      turnId = m.id
      for (const p of m.parts) {
        if (p.type !== 'text') {
          continue
        }
        const v = stripOpencroftTags(p.text || '')
        if (!v.trim()) {
          continue
        }
        blocks.push({ id: `u:${m.id}`, kind: 'user', text: v })
      }
      continue
    }
    if (firstReplyId === null) {
      firstReplyId = m.id
    }
    for (const p of m.parts) {
      if (p.type === 'text') {
        const v = stripOpencroftTags(p.text || '…')
        if (!v.trim()) {
          continue
        }
        details.push({ kind: 'assistant-text', text: v })
      } else if (p.type === 'thinking') {
        if (!p.text.trim()) {
          continue
        }
        details.push({ kind: 'thinking', text: p.text })
      } else {
        details.push({ kind: 'tool', id: p.id, name: p.name, args: p.args, result: p.result })
      }
    }
  }
  flush()
  return blocks
}

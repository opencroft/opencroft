import type { ChatEvent } from 'agent-client/types'

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
export type Block = { id: string; kind: 'user'; text: UserText } | { id: string; kind: 'details'; items: DetailItem[] }

declare const userTextBrand: unique symbol

// A user message's own words, with everything the app added on the way to the
// agent removed. Branded so it cannot be produced by writing a string: anything
// that renders a user message asks for this type, so the only way to get one is
// through `userText` below.
//
// The brand is the point. Stripping used to be a call every renderer had to
// remember, and the sticky header for a partly-loaded turn forgot — it
// read text straight off the stream event, so that one turn showed the system
// tags no other message shows. A convention that is remembered three times out
// of four isn't a convention. This makes forgetting a type error.
export type UserText = string & { readonly [userTextBrand]: true }

function stripOpencroftTags(text: string): string {
  return text.replace(/<opencroft-[a-z0-9-]+>[\s\S]*?<\/opencroft-[a-z0-9-]+>\s*/gi, '')
}

// The one transformation from a raw prompt to the words a reader sees.
//
// Null means "renders nothing": a message that is entirely system tags has no
// words of its own, and shows no bubble. Callers get that as a value they have
// to handle rather than as an empty string that quietly renders an empty box.
export function userText(raw: string): UserText | null {
  const stripped = stripOpencroftTags(raw)
  return stripped.trim() ? (stripped as UserText) : null
}

// The sticky header for a turn the loaded window starts inside — its own user
// message sits above the window, so it arrives beside the events rather than in
// them and is the one user text `buildBlocks` never sees.
//
// `index` survives even when the text doesn't, and that separation is
// load-bearing rather than tidiness: the index names the enclosing turn, which
// is what keeps the leading details block from being renamed by every mid-turn
// page — a regression fixed earlier. A header whose text is all tags must still
// report its index, so "no words" and "no header" are deliberately different
// things here.
export function headerFromWindow(header?: { index: number; event: ChatEvent } | null): {
  index: number
  text: UserText | null
} | null {
  if (header?.event.kind !== 'user') {
    return null
  }
  return { index: header.index, text: userText(header.event.text) }
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
        const v = userText(p.text || '')
        if (v === null) {
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

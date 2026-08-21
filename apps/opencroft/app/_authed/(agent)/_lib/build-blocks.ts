import type { Block } from 'agent-chat/components/chat-conversation'
import type { ChatUserMessagePart, DetailItem, UserText } from 'agent-chat/components/chat-turn'
import type { ChatUnreadMessage } from 'agent-chat/components/chat-unread'
import { toUserParts } from 'agent-chat/user-parts'
import type { ChatEvent, QueuedPrompt } from 'agent-client/types'

import type { ChatMessage } from '@/app/_authed/(agent)/_lib/messages'

// Re-exported rather than redeclared, same reasoning as `UserText` below: the
// component that renders these is what defines their shape, so there is
// exactly one definition. A second one here would drift the moment either
// side changed independently — the app's copy briefly had an id on every
// entry and a narrower tool result, which passed here and would only have
// failed at the component boundary, in a different file, on a different day.
// Re-exported rather than redeclared, same reasoning: `id` is the React key,
// and it has to name the same block before and after a "load older" prepend,
// which is a constraint owned by whichever component actually renders these —
// see the type's own definition for why a user block and a details block are
// named differently.
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
// Re-exported rather than redeclared. The brand now lives with the component
// that demands it, so there is exactly one of it: two structurally different
// brands for the same idea would each be unforgeable and mutually unassignable,
// which is a cast at the boundary and the guarantee gone.
export type { Block, DetailItem, UserText }

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

// A user turn as the transcript renders it: the whole turn as it was delivered,
// and that same delivery read back into the messages it carried.
//
// Both, because they are asked for by different things. `parts` is what draws.
// `text` stays whole — it is what an edit puts back into the composer, and
// anything trimmed out of it here would be trimmed out of the message on the
// way back out, where nothing would notice. That is also why it keeps the
// delivery's own tag lines: they are how the turn's authors and times survive a
// session reload, so a re-send that dropped them would lose them for good.
//
// Null when the turn has no words at all — every message in it was system tags
// and nothing else. That turn draws no bubble, exactly as before.
function userTurn(raw: string): { text: UserText; parts: ChatUserMessagePart[] } | null {
  const parts = toUserParts(raw, userText)
  const text = userText(raw)
  return parts.length > 0 && text !== null ? { text, parts } : null
}

// The one branded value that is not somebody's words. It exists so a message
// with no words of its own can still occupy a row, and it is declared here
// because this module is the only place a `UserText` is ever produced —
// spelling the cast at a call site instead would make the brand forgeable
// anywhere.
const EMPTY_USER_TEXT = '' as UserText

// What is waiting to be read, as the reader sees it: the same strip `userText`
// does for a delivered message, applied to one not delivered yet.
//
// A prompt that is nothing but tags keeps its row with empty words rather than
// disappearing. It is still being held and can still be taken back, and a row
// that is not drawn is one the reader cannot remove.
//
// A system prompt has no author and no send time, which is why the union is
// read here rather than flattened: the fields are absent, not blank.
export function buildUnread(queue: readonly QueuedPrompt[]): ChatUnreadMessage[] {
  return queue.map((entry) => ({
    id: entry.id,
    text: userText(entry.text) ?? EMPTY_USER_TEXT,
    sender: entry.kind === 'message' ? entry.sender : undefined,
    sentAt: entry.kind === 'message' ? entry.sentAt : undefined,
  }))
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
        const turn = userTurn(p.text || '')
        if (turn === null) {
          continue
        }
        blocks.push({ id: `u:${m.id}`, kind: 'user', ...turn })
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

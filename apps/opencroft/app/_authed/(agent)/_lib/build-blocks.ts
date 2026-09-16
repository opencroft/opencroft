import type { Block } from 'agent-chat/components/chat-conversation'
import type { ChatUserMessagePart, DetailItem, MessageAttachment, UserText } from 'agent-chat/components/chat-turn'
import type { ChatUnreadMessage } from 'agent-chat/components/chat-unread'
import { toUserParts } from 'agent-chat/user-parts'
import type { QueuedPrompt } from 'agent-client/types'

import type { AuthoredChatEvent, ResolvedAuthor } from '@/app/_authed/(agent)/_lib/acp-stream'
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

// The envelope tag a reader's selection travels in. Not anchored: one delivery
// can carry several messages, and this reads each message's own text.
const USER_SELECTION_TAG = /<opencroft-user-selection>([\s\S]*?)<\/opencroft-user-selection>/gi

// What a message carried besides its words, so the bubble can show that it
// carried anything at all. Without this the strip above is total: a message sent
// with a page of context attached renders identically to one sent with none.
//
// Only the reader's own selection, not every `<opencroft-*>` part. The task and
// instruction tags are standing context this application injects once per
// session -- nobody attached them, and a chip on the first message of every
// conversation would say nothing about that message.
//
// THE LABEL IS DERIVED, and that is a property of the envelope rather than a
// shortcut taken here. The tag carries what the AGENT received; the label the
// composer's chip showed was presentation and never travelled, so there is
// nothing on the wire to read it from. Every message sent before these chips
// existed is in that state permanently, which is why deriving it is not a
// stopgap until the wire changes -- it is the only thing that can ever describe
// one of those.
//
// The first line, because these selections introduce themselves: every publisher
// in this app opens its content with a `Key: value` line naming the source. The
// whole of it goes on the chip's title, so the choice of line hides nothing.
//
// WHAT THAT COSTS, counted rather than assumed. Enumerated 10.09.2026: five
// publishers reach this, and the first line names the SOURCE in every one of
// them -- `Design project: …` for a design-kit project and for a component
// inside it, `Documentation: …` for an open document and for a highlight within
// it, `Repository: …` for a file in a repository. So the chip says where the
// context came from and not which part of it, and the part is what the reader
// picked. The label the composer's own chip showed was better, and it cannot be
// recovered: it was presentation and never travelled. Hover carries the rest.
//
// The two guards below are not for those five. `useSelection` is on the host
// API, so any extension can publish any content it likes, and neither an empty
// first line nor a whole payload on one line is reachable from this app today.
const MAX_LABEL = 80

// What a chip says when the attachment gives it nothing to be named by. A chip
// that says nothing is worse than no chip: it reports that something travelled
// while withholding the one thing it exists to report.
const UNNAMED_ATTACHMENT = 'Attached context'

function attachmentLabel(detail: string): string {
  // `detail` is already trimmed, so a first line can only be empty if the whole
  // of it was -- which is refused before this is reached. The branch stays
  // because that is an argument about today's callers, not a property of the
  // function.
  const [firstLine = ''] = detail.split('\n')
  const trimmed = firstLine.trim()
  if (!trimmed) {
    return UNNAMED_ATTACHMENT
  }
  // The chip truncates at its own width, so this is not what makes it fit. It
  // bounds the string itself, which is what reaches the accessibility tree and
  // the title of anything that renders one: a publisher putting a page on one
  // line would otherwise put that page in a label.
  return trimmed.length > MAX_LABEL ? `${trimmed.slice(0, MAX_LABEL - 1)}…` : trimmed
}

function attachmentsOf(raw: string): MessageAttachment[] {
  const attachments: MessageAttachment[] = []
  for (const [, content] of raw.matchAll(USER_SELECTION_TAG)) {
    const detail = content.trim()
    if (!detail) {
      continue
    }
    attachments.push({ label: attachmentLabel(detail), detail })
  }
  return attachments
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
function userTurn(
  raw: string,
  // The accounts this delivery's senders resolve to, as the message carried
  // them. Passed straight through: this function decides what a turn is, not
  // who anybody is.
  authors?: Record<string, ResolvedAuthor>,
): { text: UserText; parts: ChatUserMessagePart[] } | null {
  const parts = toUserParts(raw, userText, authors, attachmentsOf)
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
//
// `sender` on the way in, `author` on the way out: the queue is wire shape and
// the message is render shape, and the two deliberately do not share a word.
//
// The callback's return type is annotated rather than left to inference, and
// that annotation is the whole guard: only a literal with a declared target
// gets excess-property checking, so writing the wire name here is a compile
// error rather than a key nothing reads. Without it this returned `sender` for
// a while after the render shape was renamed -- still assignable, so the
// workspace typecheck stayed green while every waiting message drew blank
// where its author goes.
export function buildUnread(
  queue: readonly QueuedPrompt[],
  // The accounts this snapshot's senders resolve to. Here for the same reason
  // it is on a delivered turn: a message waiting to be read and the same
  // message once it has been handed over are one message, and one of them
  // showing a bare identifier while the other shows a face would be two.
  authors?: Record<string, ResolvedAuthor>,
): ChatUnreadMessage[] {
  return queue.map((entry): ChatUnreadMessage => {
    const author = entry.kind !== 'system' ? entry.sender : undefined
    const authorAccount = author ? authors?.[author] : undefined
    // The same reading a delivered message gets, through the same function --
    // not a second one that agrees with it. A message waiting to be read and the
    // same message once it has been handed over are one message, and one of them
    // showing what it carries while the other does not would be two.
    const attachments = attachmentsOf(entry.text)
    return {
      id: entry.id,
      text: userText(entry.text) ?? EMPTY_USER_TEXT,
      author,
      // `satisfies` rather than a bare spread. An optional key spread into a
      // literal is NOT excess-property-checked against the literal's target
      // type -- the key name sails through misspelled, which is how a field
      // survived a rename here for ten hours behind a green typecheck. The
      // annotation on the callback is what checks the rest of this object; it
      // cannot reach inside a spread, so the spread carries its own.
      ...(authorAccount ? ({ authorAccount } satisfies Pick<ChatUnreadMessage, 'authorAccount'>) : {}),
      // Carried on the same terms: an empty list is absence, and a message
      // holding one would draw an empty row above its words.
      ...(attachments.length ? ({ attachments } satisfies Pick<ChatUnreadMessage, 'attachments'>) : {}),
      sentAt: entry.kind !== 'system' ? entry.sentAt : undefined,
    }
  })
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
export function headerFromWindow(header?: { index: number; event: AuthoredChatEvent } | null): {
  index: number
  parts: readonly ChatUserMessagePart[]
} | null {
  if (header?.event.kind !== 'user') {
    return null
  }
  // The SAME reading a loaded turn gets, through the same function -- not a
  // second one that agrees with it. A header is one delivered prompt read back
  // into the messages it carried, and how much of the turn happens to be in the
  // window is not an input to that.
  //
  // This is the third time this seam has lost a guarantee the loaded path had.
  // Twice it was patched by teaching this function to do the missing step --
  // strip the tags, then parse them -- and each patch left two paths that
  // agreed until the next field was added, at which point only one of them
  // learned about it. Calling the same function is what makes a fourth
  // impossible rather than unlikely.
  //
  // Empty parts, not a dropped header: `index` names the enclosing turn and is
  // what stops the leading details block being renamed by every mid-turn page.
  // "No words" and "no header" stay different things.
  // The header's own resolved accounts, for the same reason the reading itself
  // is shared: a header and the block that replaces it are one message, so if
  // only one of them could show a face they would be two behaviours again.
  return { index: header.index, parts: userTurn(header.event.text, header.event.authors)?.parts ?? [] }
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
        const turn = userTurn(p.text || '', m.authors)
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
      const item = partToDetail(p)
      if (item) {
        details.push(item)
      }
    }
  }
  flush()
  return blocks
}

// One reply part → the detail item that draws it, or null when it renders
// nothing (an empty text/thinking part). Shared by the parent chain and,
// recursively, by a subagent's nested transcript, so both draw text, thinking
// and tools identically.
function partToDetail(p: ChatMessage['parts'][number]): DetailItem | null {
  if (p.type === 'text') {
    const v = stripOpencroftTags(p.text || '…')
    return v.trim() ? { kind: 'assistant-text', text: v } : null
  }
  if (p.type === 'thinking') {
    return p.text.trim() ? { kind: 'thinking', text: p.text } : null
  }
  if (p.type === 'subagent') {
    return {
      kind: 'subagent',
      id: p.subagentSessionId,
      name: p.name,
      task: p.task,
      state: p.state,
      items: p.parts.map(partToDetail).filter((item): item is DetailItem => item !== null),
    }
  }
  return { kind: 'tool', id: p.id, name: p.name, args: p.args, result: p.result }
}

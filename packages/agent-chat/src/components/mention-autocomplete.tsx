'use client'

import { AgentAvatar } from 'ui/components/ui/media/agent-avatar'

import { ComposerSuggestions, type ComposerSuggestionsSide } from './composer-suggestions'

/** Someone the composer can mention: a person or an agent, offered alike. */
export interface MentionCandidate {
  /** What a mention writes after the `@`. The host's identifier, inserted as
   *  given: the composer neither checks nor reshapes it. */
  handle: string
  name: string
  avatarUrl?: string | null
}

/** A mention being typed: where its `@` is, where it ends (the caret), and
 *  what has been typed between the two. */
export interface MentionToken {
  start: number
  end: number
  query: string
}

/**
 * The mention being typed at the caret, or null when there is none.
 *
 * A mention begins with an `@` at the start of the text or after whitespace,
 * so the `@` of an e-mail address opens nothing, and runs to the caret.
 * Whatever follows the caret is not part of it: with the caret put before a
 * word and `@ad` typed there, choosing a row keeps that word.
 */
export function mentionToken(text: string, caret: number): MentionToken | null {
  const typed = /(?:^|\s)@(\S*)$/.exec(text.slice(0, caret))
  if (!typed) {
    return null
  }
  const query = typed[1]
  return { start: caret - query.length - 1, end: caret, query }
}

// Whether `query` begins `value` at its start or right after a character that
// is neither a letter nor a digit: `ad` finds `agent.ada`, `lov` finds
// `Ada Lovelace`, and `da` finds neither.
function startsAPart(value: string, query: string): boolean {
  for (let index = 0; index <= value.length - query.length; index++) {
    if ((index === 0 || !/[\p{L}\p{N}]/u.test(value[index - 1])) && value.startsWith(query, index)) {
      return true
    }
  }
  return false
}

/**
 * The candidates a mention query finds, in the order given.
 *
 * The query is matched without regard to case against the handle and the
 * name, at the start of either or of any part of them, so `agent.ad`, `ad`
 * and `Ada` all find the same account. A query that begins no part falls
 * back to anywhere in either, so a remembered middle still finds. An empty
 * query finds everyone.
 */
export function filterMentions(candidates: readonly MentionCandidate[], query: string): MentionCandidate[] {
  const wanted = query.toLowerCase()
  const fields = (candidate: MentionCandidate) => [candidate.handle.toLowerCase(), candidate.name.toLowerCase()]
  const prefixed = candidates.filter((candidate) => fields(candidate).some((field) => startsAPart(field, wanted)))
  if (prefixed.length > 0) {
    return prefixed
  }
  return candidates.filter((candidate) => fields(candidate).some((field) => field.includes(wanted)))
}

/**
 * The candidates the popup offers for the composer's text at the caret, or
 * null when the popup should not be open at all.
 *
 * Null and [] differ as they do for commands: null means no mention is being
 * typed or there is nobody to offer, [] means one is being typed and nobody
 * matches. Both hide the popup; only null also means there is nothing to
 * intercept keys for.
 */
export function matchMentions(
  candidates: readonly MentionCandidate[],
  text: string,
  caret: number,
): MentionCandidate[] | null {
  const token = mentionToken(text, caret)
  if (token === null || candidates.length === 0) {
    return null
  }
  return filterMentions(candidates, token.query)
}

/**
 * The text with the mention at `token` replaced by `@<handle>` and a space,
 * and where the caret goes: just after that space. A space already following
 * the mention is reused rather than doubled; anything else after it is kept,
 * set apart by the inserted space.
 */
export function insertMention(text: string, token: MentionToken, handle: string): { text: string; caret: number } {
  const inserted = `@${handle} `
  const after = text.slice(token.end)
  const rest = after.startsWith(' ') ? after.slice(1) : after
  return { text: text.slice(0, token.start) + inserted + rest, caret: token.start + inserted.length }
}

export interface MentionAutocompleteProps {
  items: readonly MentionCandidate[]
  activeIndex: number
  onSelect: (candidate: MentionCandidate) => void
  onHover: (index: number) => void
  /** See `ComposerSuggestionsProps.side`. */
  side?: ComposerSuggestionsSide
}

/**
 * The mention popup: who can be mentioned, each row the avatar, the name and
 * the handle. The same popup as the command one, opened in the same place and
 * driven by the same keys. Pure presentation — which candidates, which is
 * active and what selecting does are the composer's.
 */
export function MentionAutocomplete({ items, activeIndex, onSelect, onHover, side }: MentionAutocompleteProps) {
  return (
    <ComposerSuggestions
      label='Mentions'
      side={side}
      items={items}
      itemKey={(candidate) => candidate.handle}
      renderItem={(candidate) => (
        <>
          {/* No alt text: the name is the next thing in the row. */}
          <span className='self-center'>
            <AgentAvatar avatar={candidate.avatarUrl} size='sm' />
          </span>
          <span className='min-w-0 truncate'>{candidate.name}</span>
          <span className='min-w-0 flex-1 truncate font-mono text-xs text-muted-foreground'>{candidate.handle}</span>
        </>
      )}
      activeIndex={activeIndex}
      onSelect={onSelect}
      onHover={onHover}
    />
  )
}

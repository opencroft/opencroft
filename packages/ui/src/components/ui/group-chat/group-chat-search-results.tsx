'use client'

import type { ReactNode } from 'react'

import { AgentAvatar } from '../media/agent-avatar'
import { ListRow } from '../utils/list-row'

/** A piece of a snippet; `match` marks the words the search found. */
export interface SearchSnippetPart {
  text: string
  match: boolean
}

export interface GroupChatMessageHit {
  /** The host's own id for the hit, handed back on press. */
  id: string
  threadTitle: string | null
  agent: { name: string; avatarUrl?: string | null }
  /** Whether the match is in the question or the agent's reply. */
  role: 'user' | 'agent'
  snippet: readonly SearchSnippetPart[]
  /** The hit is in an archived thread. */
  archived?: boolean
}

export interface GroupChatSearchResultsProps {
  /** The threads whose title matches, already drawn -- the same rows the thread list draws. */
  threads?: ReactNode
  messages: readonly GroupChatMessageHit[]
  onSelectMessage: (id: string) => void
  /** The message search is still answering. */
  loading?: boolean
  /** More messages matched than are shown. */
  truncated?: boolean
}

// How much plain text may stand before the first matched word. A row is one
// line, so anything longer can push the match out of sight at phone width.
const LEAD_CHARS = 24

export function GroupChatSearchResults({
  threads,
  messages,
  onSelectMessage,
  loading = false,
  truncated = false,
}: GroupChatSearchResultsProps) {
  if (!threads && messages.length === 0 && !loading) {
    return <p className='px-1 py-2 text-sm text-muted-foreground'>No threads or messages match the search.</p>
  }
  return (
    <div className='flex w-full min-w-0 flex-col gap-3'>
      {threads ? (
        <section className='flex min-w-0 flex-col gap-1'>
          <h3 className='px-2 text-xs font-medium text-muted-foreground'>Threads</h3>
          {threads}
        </section>
      ) : null}
      <section className='flex min-w-0 flex-col gap-1'>
        <h3 className='px-2 text-xs font-medium text-muted-foreground'>Messages</h3>
        {messages.length > 0 ? (
          <div className='flex min-w-0 flex-col gap-0.5'>
            {messages.map((hit) => (
              <ListRow
                key={hit.id}
                leading={<AgentAvatar avatar={hit.agent.avatarUrl} name={hit.agent.name} />}
                title={`${hit.threadTitle ?? 'Untitled'}${hit.archived ? ' · Archived' : ''}`}
                secondary={
                  <>
                    {hit.role === 'agent' ? `${hit.agent.name}: ` : null}
                    <Snippet parts={leadWithMatch(hit.snippet)} />
                  </>
                }
                onSelect={() => onSelectMessage(hit.id)}
              />
            ))}
          </div>
        ) : (
          <p className='px-2 text-sm text-muted-foreground'>{loading ? 'Searching messages…' : 'No messages match.'}</p>
        )}
        {truncated ? (
          <p className='px-2 text-xs text-muted-foreground'>Showing the newest matches. Add a word to narrow it down.</p>
        ) : null}
      </section>
    </div>
  )
}

function Snippet({ parts }: { parts: readonly SearchSnippetPart[] }) {
  return (
    <>
      {parts.map((part, index) =>
        part.match ? (
          // biome-ignore lint/suspicious/noArrayIndexKey: parts are positional and never reordered
          <mark key={index} className='bg-transparent font-semibold text-foreground'>
            {part.text}
          </mark>
        ) : (
          // biome-ignore lint/suspicious/noArrayIndexKey: parts are positional and never reordered
          <span key={index}>{part.text}</span>
        ),
      )}
    </>
  )
}

/** The snippet with the plain text before its first match cut to its last few words. */
export function leadWithMatch(parts: readonly SearchSnippetPart[]): SearchSnippetPart[] {
  const first = parts.findIndex((part) => part.match)
  if (first === -1) {
    return [...parts]
  }
  const before = parts.slice(0, first).map((part) => part.text).join('')
  if (before.length <= LEAD_CHARS) {
    return [...parts]
  }
  const tail = before.slice(-LEAD_CHARS)
  const wordStart = tail.indexOf(' ')
  const lead = `…${wordStart === -1 ? tail : tail.slice(wordStart + 1)}`
  return [{ text: lead, match: false }, ...parts.slice(first)]
}

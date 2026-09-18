'use client'

import { AgentAvatar } from '../media/agent-avatar'
import { type ChatStatus, STATUS_DOT, STATUS_WORD } from '../chat/chat-list-item'
import { LIST_ROW_SECONDARY_CLASS, LIST_ROW_TITLE_CLASS } from '../utils/list-row'
import { cn } from 'ui/lib/utils'

// Re-exported so a consumer that only draws this cluster can type its status
// without reaching past it to the row the vocabulary comes from.
export type { ChatStatus }

export interface ThreadAgentClusterProps {
  /** The fixed agent the thread is with. */
  agent: { name: string; avatarUrl?: string | null }
  /** The agent's process state, in the chat list row's vocabulary: one value
   * drives the dot on the avatar and the word after the name, so the two
   * cannot disagree. Omit to show the name alone. */
  status?: ChatStatus
  /** The group chat's NAME -- a breadcrumb names a place, and what a place is
   * called is what locates it; never the slug it is addressed by. */
  groupChatName: string
  /** The thread's own title; empty falls back to "Thread". */
  threadTitle?: string | null
  className?: string
}

// Who a thread is with and where it is, drawn in a chat list row's own terms:
// the avatar wears the row's status dot, the breadcrumb sits in the row's
// description style, and the agent's line -- "Carol · Working", one string in
// the row's title style, exactly as the row composes "Name · Status" -- under
// it. The classes and the vocabulary are IMPORTED from the row and the row's
// item rather than restated here, so a list row and the header a press on it
// opens cannot drift apart by a token or a word.
//
// A cluster and not a header: it owns no border, no padding and no trailing
// side. The thread framing puts it in its header and the dock window puts it
// in the header it already has, and neither wants a second header inside.
export function ThreadAgentCluster({ agent, status, groupChatName, threadTitle, className }: ThreadAgentClusterProps) {
  const statusWord = status ? STATUS_WORD[status] : null
  const agentLine = statusWord ? `${agent.name} · ${statusWord}` : agent.name
  return (
    <div className={cn('flex min-w-0 items-center gap-2', className)} title={agentLine}>
      <AgentAvatar avatar={agent.avatarUrl} name={agent.name} statusIndicator={status ? STATUS_DOT[status] : undefined} />
      {/* The same two-line stack a list row draws its text in: breadcrumb
          above in the description style, the agent below in the title style.
          Both truncate on their own line, so a long thread title costs the
          breadcrumb its tail and never the agent's line. */}
      <span className='flex min-w-0 flex-1 flex-col overflow-hidden leading-tight'>
        <span className={LIST_ROW_SECONDARY_CLASS}>
          {groupChatName} / {threadTitle || 'Thread'}
        </span>
        <span className={LIST_ROW_TITLE_CLASS}>{agentLine}</span>
      </span>
    </div>
  )
}

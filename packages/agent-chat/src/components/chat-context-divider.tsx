'use client'

// What restarted the agent's context at this point: a new session took the
// conversation over, or a compaction replaced what came before with a summary.
export type ChatContextStartReason = 'new-session' | 'compaction'

const LABELS: Record<ChatContextStartReason, string> = {
  'new-session': 'New session',
  compaction: 'Context compacted',
}

const EXPLANATIONS: Record<ChatContextStartReason, string> = {
  'new-session': 'The agent’s context starts here. Messages above are history this session does not hold.',
  compaction: 'The agent’s context restarts here from a summary. Messages above are history it holds only as that summary.',
}

export interface ChatContextDividerProps {
  reason: ChatContextStartReason
}

// A rule across the conversation where the agent's context begins again. The
// transcript above it stays readable as it was; the rule says that the agent
// on the other side of the composer no longer has it. One per restart, so a
// conversation restarted several times shows each.
export function ChatContextDivider({ reason }: ChatContextDividerProps) {
  const explanation = EXPLANATIONS[reason]
  return (
    <div
      role='separator'
      aria-label={`${LABELS[reason]}. ${explanation}`}
      title={explanation}
      className='flex w-full items-center gap-2 text-xs font-medium text-muted-foreground'
    >
      <span className='h-px min-w-6 flex-1 bg-border' />
      <span>{LABELS[reason]}</span>
      <span className='h-px min-w-6 flex-1 bg-border' />
    </div>
  )
}

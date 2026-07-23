// Shared envelope composer for every path that delivers a message into an agent
// session (chat UI, send-message/notification pipeline). Isomorphic — no
// server-only imports — so both a client component and a server module can
// import it directly instead of keeping their own copy in sync by hand.
//
// Two independent axes decide what gets prefixed to a message:
//   - `system`: sender-dependent (chat UI only), present or absent per call.
//   - `sessionInit`: content that defines who the agent is and what job it's
//     doing (task context, standing instructions, chat's title request) —
//     session-scoped, so it must only be attached when `isNewSession` is true,
//     regardless of which sender created the session.
// A leading slash marks a command, never a conversational message — passed
// through unwrapped by every sender.

export interface SystemContext {
  spaceName: string
  spaceSlug: string
  selectedNodeId: string | null
}

export interface SessionInitContext {
  jobContext?: string
  instructions?: string[]
  /** Chat-only: asks the agent to self-title its first reply. */
  titleRequest?: string
}

export interface ComposeEnvelopeOptions {
  system?: SystemContext
  sessionInit?: SessionInitContext
  isNewSession: boolean
}

export function composeEnvelope(message: string, opts: ComposeEnvelopeOptions): string {
  if (message.trim().startsWith('/')) {
    return message
  }

  const parts: string[] = []

  if (opts.system) {
    const { spaceName, spaceSlug, selectedNodeId } = opts.system
    parts.push(
      `<opencroft-system>Sent from OpenCroft space: ${spaceName} (${spaceSlug}). Selected node: ${selectedNodeId ?? 'none'}. This may or may not relate to the current request.</opencroft-system>`,
    )
  }

  if (opts.isNewSession && opts.sessionInit) {
    const { jobContext, instructions, titleRequest } = opts.sessionInit
    if (titleRequest) {
      parts.push(titleRequest)
    }
    if (jobContext?.trim()) {
      parts.push(`<opencroft-task>${jobContext.trim()}</opencroft-task>`)
    }
    for (const instr of instructions ?? []) {
      const trimmed = instr.trim()
      if (trimmed) {
        parts.push(`<opencroft-instruction>${trimmed}</opencroft-instruction>`)
      }
    }
  }

  return parts.length ? `${parts.join('\n')}\n${message}` : message
}

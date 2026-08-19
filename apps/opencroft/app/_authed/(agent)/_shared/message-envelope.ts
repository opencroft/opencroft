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

/**
 * Prefix a message with the reader's current selection, wrapped in its own
 * envelope tag. The selection travels as context the same way the other
 * `<opencroft-*>` parts do: ahead of the message, stripped from the user
 * bubble by the display side's tag stripper, delivered verbatim to the agent.
 *
 * `content` is what the agent receives — the selection's label is presentation
 * and stays on the screen that showed it. A blank content wraps nothing, and a
 * leading slash marks a command (same rule as composeEnvelope above), passed
 * through untouched.
 */
export function wrapUserSelection(message: string, content: string): string {
  const trimmed = content.trim()
  if (!trimmed || message.trim().startsWith('/')) {
    return message
  }
  return `<opencroft-user-selection>${trimmed}</opencroft-user-selection>\n${message}`
}

function pad(n: number): string {
  return String(n).padStart(2, '0')
}

// dd.mm.yyyy hh:mm:ss, UTC. The platform has no per-user timezone — agents
// only ever see a server clock — so a bare UTC reading is the one that stays
// correct regardless of which environment's clock produced it; there is
// nothing for an explicit label to disambiguate.
function formatOpencroftTime(date: Date): string {
  return `${pad(date.getUTCDate())}.${pad(date.getUTCMonth() + 1)}.${date.getUTCFullYear()} ${pad(date.getUTCHours())}:${pad(date.getUTCMinutes())}:${pad(date.getUTCSeconds())}`
}

// Stamps a message with the moment it is actually delivered to the agent.
// Wired into agent-client's delivery chokepoint (deliverPrompt) rather than
// called at compose time, so a message held behind a running turn carries the
// time the agent received it, not the time it was sent — and a batch a queue
// flush joins into one turn carries a single stamp, matching the one moment
// it was actually delivered. A leading slash marks a command (same rule as
// composeEnvelope above) and is passed through unstamped for the same
// reason: a `/compact` a flush joins into a batch must still start with a
// slash for the harness to recognize it.
export function stampDeliveryTime(text: string, now: Date): string {
  if (text.trim().startsWith('/')) {
    return text
  }
  return `<opencroft-time>${formatOpencroftTime(now)}</opencroft-time>\n${text}`
}

import type { AgentChatProps } from 'agent-chat/agent-chat'
import type { ApprovalsSession } from 'agent-chat/approvals'

import type { AgentSession } from '@/app/_authed/(agent)/_components/agent-chat'
import type { AcpSession } from '@/app/_authed/(agent)/_components/use-acp-session'

// Compile-time conformance pins against packages/agent-chat's named
// session-shape contract (agent-chat/session.ts's AgentChatSession, Picked
// down per component). Nothing here runs — `declare const` produces no JS,
// and a `satisfies` expression checks assignability without needing a real
// value — so these exist purely to fail the build the moment either side
// drifts: a field renamed or dropped on this app's session types, or a field
// added to what a package component actually reads, surfaces here instead of
// three call sites away as a silent prop-shape mismatch.
//
// Two pins, not one, because this app keeps the two halves of the contract on
// two different objects rather than one merged session: AgentSession carries
// the transcript/turn-control fields AgentChat reads, AcpSession (which wraps
// an AgentSession alongside the approval queues) carries what Approvals reads
// — see use-acp-session.ts for why they're split this way.
declare const agentChatConformance: AgentSession
agentChatConformance satisfies AgentChatProps['session']

declare const approvalsConformance: AcpSession
approvalsConformance satisfies ApprovalsSession

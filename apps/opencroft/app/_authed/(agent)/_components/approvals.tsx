'use client'

import { AppearGuard, AskPrompt, PermissionRequest } from 'agent-chat/messages'

import type { AcpSession } from '@/app/_authed/(agent)/_components/use-acp-session'

// Every unresolved permission request and elicitation for one session, with the
// controls that answer them.
//
// This is its own module rather than a helper beside one host because EVERY
// surface that opens a session needs it, and the cost of not rendering it is
// not a missing decoration: a turn blocked on an approval that has nowhere to
// be granted cannot proceed at all, and the only way out is to kill the turn --
// which reaches the agent as a refusal it never earned. A second host quietly
// omitting it is exactly how that happens, so there is one copy and both hosts
// import it.
//
// Requests here are unresolved by construction: the session drops one from
// these lists the moment it is answered, rather than keeping it around to say
// so. Hence `resolved: false` in the shapes below.
export function Approvals({ acp }: { acp: AcpSession }) {
  if (acp.permissions.length === 0 && acp.asks.length === 0) {
    return null
  }
  return (
    <div className='flex flex-col gap-2 px-4 pb-2'>
      {acp.permissions.map((p) => (
        <AppearGuard key={p.requestId}>
          <PermissionRequest
            message={{
              id: p.requestId,
              kind: 'permission',
              requestId: p.requestId,
              title: p.title,
              options: p.options,
              resolved: false,
            }}
            onRespond={acp.resolvePermission}
            onRespondText={acp.respondPermissionText}
          />
        </AppearGuard>
      ))}
      {acp.asks.map((a) => (
        <AppearGuard key={a.requestId}>
          <AskPrompt
            message={{ id: a.requestId, kind: 'ask', requestId: a.requestId, message: a.message, resolved: false }}
            onRespond={acp.resolveAsk}
          />
        </AppearGuard>
      ))}
    </div>
  )
}

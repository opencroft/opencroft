'use client'

import { AskUrl, AskUser } from './components/ask-user'
import { AppearGuard, AskPrompt, PermissionRequest } from './messages'
import type { AgentChatSession, PendingAsk, PendingPermission } from './session'

export type { PendingAsk, PendingPermission }

// The minimal Pick of the named session-shape contract (session.ts)
// `Approvals` needs — not the host's full session controller. A host's own
// richer session type structurally satisfies this without a wrapper, since
// it already carries every field the full contract documents.
export type ApprovalsSession = Pick<
  AgentChatSession,
  'permissions' | 'asks' | 'resolvePermission' | 'respondPermissionText' | 'resolveAsk'
>

// Every unresolved permission request and elicitation for one session, with the
// controls that answer them.
//
// This is its own module rather than a helper beside one host because EVERY
// surface that opens a session needs it, and the cost of not rendering it is
// not a missing decoration: a turn blocked on an approval that has nowhere to
// be granted cannot proceed at all, and the only way out is to kill the turn --
// which reaches the agent as a refusal it never earned. A second host quietly
// omitting it is exactly how that happens, so there is one copy and every host
// imports it.
//
// Requests here are unresolved by construction: the session drops one from
// these lists the moment it is answered, rather than keeping it around to say
// so. Hence `resolved: false` in the shapes below.
export function Approvals({ session }: { session: ApprovalsSession }) {
  if (session.permissions.length === 0 && session.asks.length === 0) {
    return null
  }
  return (
    <div data-slot='approvals' className='flex flex-col gap-2 px-4 pb-2'>
      {session.permissions.map((p) => (
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
            onRespond={session.resolvePermission}
            onRespondText={session.respondPermissionText}
          />
        </AppearGuard>
      ))}
      {session.asks.map((a) => (
        <AppearGuard key={a.requestId}>
          {/* Three ask shapes, one slot: a form renders its schema, a url
              renders its link, and everything else stays the free-text prompt
              it always was. Which shape an ask is came from the agent's own
              elicitation mode — see PendingAsk in the session contract. */}
          {a.form ? (
            <div className='rounded-md border'>
              <AskUser
                message={a.message}
                schema={a.form}
                onSubmit={(content) => session.resolveAsk(a.requestId, content)}
                onCancel={() => session.resolveAsk(a.requestId)}
              />
            </div>
          ) : a.url ? (
            <AskUrl
              message={a.message}
              url={a.url}
              onDone={() => session.resolveAsk(a.requestId, {})}
              onCancel={() => session.resolveAsk(a.requestId)}
            />
          ) : (
            <AskPrompt
              message={{ id: a.requestId, kind: 'ask', requestId: a.requestId, message: a.message, resolved: false }}
              onRespond={session.resolveAsk}
            />
          )}
        </AppearGuard>
      ))}
    </div>
  )
}

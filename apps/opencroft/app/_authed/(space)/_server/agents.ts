// EVERY runtime export in this file must stay a `createServerFn`. It is
// imported directly by browser components (ai-panel.tsx,
// use-chat-list-nodes.ts), and survives in the client graph only because the
// client build can replace each server fn with an RPC stub and then drop this
// file's top-level imports — including the native-dependent tail behind the
// spaces registry.
//
// Adding a plain exported function here would keep that tail alive in the
// client bundle and break `vite build`. The
// implementation lives in agents-impl.ts; server-side callers that need to
// call it without nesting server fns import from there.
//
// Type re-exports below are erased at build time and carry no runtime
// binding, so they are safe to expose here for the client components that
// already import them from this path.

import { createServerFn } from '@tanstack/react-start'

import { listAgentNodesImpl } from '@/app/_authed/(space)/_server/agents-impl'

export type {
  AgentInstructionRef,
  AgentJobRef,
  AgentNodeRef,
} from '@/app/_authed/(space)/_server/agents-impl'

export const listAgentNodes = createServerFn().handler(listAgentNodesImpl)

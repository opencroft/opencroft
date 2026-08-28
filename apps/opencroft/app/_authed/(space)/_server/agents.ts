// EVERY runtime export in this file must stay a `createServerFn`. It is
// imported directly by browser components (the group-chat route and members
// dialog, the embedded agent chat), and survives in the client graph only because the
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

// The handler must be an arrow function, not the point-free `.handler(listAgentNodesImpl)`.
// `vite build` tree-shakes the unreferenced `agents-impl` import away either
// way, but `vite dev`'s per-module transform does not — point-free left a
// bare `import "...agents-impl.ts"` in the client-served module, which pulls
// in @opencroft/db's `node:path` import and breaks the browser at runtime.
// Confirmed by diffing the dev server's transformed output for both forms.
export const listAgentNodes = createServerFn().handler(async () => listAgentNodesImpl())

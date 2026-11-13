import { createCsrfMiddleware, createStart } from '@tanstack/react-start'

import { serverFnSessionGate } from '@/app/_server/server-fn-session-gate'

// TanStack Start's instance options. Function middleware listed here runs
// before every server function's own middleware, in every file, including
// server functions defined in `packages/*`.
//
// Start applies its default CSRF check to server functions only when an app
// has no start instance, so having this file means registering it here: a
// server-function request from another site, or one with no Sec-Fetch-Site,
// Origin or Referer to judge it by, gets 403.
export const startInstance = createStart(() => ({
  requestMiddleware: [createCsrfMiddleware({ filter: (ctx) => ctx.handlerType === 'serverFn' })],
  functionMiddleware: [serverFnSessionGate],
}))

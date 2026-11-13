import { getSessionUser } from '@opencroft/auth/server'
import { createMiddleware } from '@tanstack/react-start'
import { getRequest } from '@tanstack/react-start/server'

import { admitServerFnCall } from '@/app/_server/server-fn-access'

// The session gate every server function runs first: `app/start.ts` registers
// it as global function middleware, so the framework puts it ahead of each
// function's own middleware and handler. Which functions are open to anonymous
// callers is `server-fn-access.ts`'s list.
//
// It runs for a server function called from server code too (a loader during
// SSR, an API route), against the request that is being served. Code that can
// run under a request with no session cookie (an MCP call, which carries a
// token instead, or a background timer) calls the plain implementation, not
// the server function.
//
// The `.server` body is stripped from the client build, so registering this in
// `start.ts`, which the client also loads, puts no auth code in the browser.
export const serverFnSessionGate = createMiddleware({ type: 'function' }).server(async ({ next, serverFnMeta }) => {
  await admitServerFnCall(serverFnMeta, async () => (await getSessionUser(getRequest())) !== null)
  return next()
})

/**
 * `@opencroft/client/actions` — calling server code from the browser: the
 * extension's own actions, a node's actions, and an App instance's actions.
 */

/** Run one of this extension's own server `actions`, with the arguments it takes. */
export declare const invoke: <T = unknown>(name: string, ...args: unknown[]) => Promise<T>

/** Run one of a graph node's actions, as `app_call`-style node dispatch does. */
export declare const dispatch: (nodeId: string, actionId: string, params?: Record<string, unknown>) => Promise<unknown>

/**
 * Run one of an App instance's actions from the App's own UI — the same
 * handler `app_call` reaches, with the result it returns. The host runs it as
 * the signed-in person: the handler's `ctx.callerPerson` is taken from the
 * session, so nothing passed here can say who is asking. Pass the
 * `instanceId` from `AppComponentProps`.
 */
export declare const callAppAction: <T = unknown>(
  instanceId: string,
  action: string,
  params?: Record<string, unknown>,
) => Promise<T>

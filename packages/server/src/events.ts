/** `@opencroft/server/events` — pushing to the extension's client half in every open browser. */

export interface HostEventsApi {
  /**
   * Fire-and-forget push to all connected clients; received in extension
   * client code via `getStream(extensionId, 'events')` from
   * `@opencroft/client/streams`.
   */
  broadcast(name: string, payload?: Record<string, unknown>): void
}

export declare const events: HostEventsApi

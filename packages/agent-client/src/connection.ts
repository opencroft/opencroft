import type { ClientSideConnection } from '@agentclientprotocol/sdk'

/**
 * The subset of an ACP client connection that the engine actually drives.
 *
 * Both arms of {@link ensureConnection} return this:
 *  - a real subprocess `ClientSideConnection` (talks ACP over stdio), and
 *  - the in-process native harness ({@link createNativeHarness}), which mimics
 *    this interface but calls the `Client` callbacks directly — no transport.
 *
 * Deriving it via `Pick` guarantees `ClientSideConnection` satisfies it and the
 * native harness can't drift from the methods the engine relies on.
 */
export type AgentConnection = Pick<
  ClientSideConnection,
  | 'initialize'
  | 'newSession'
  | 'loadSession'
  | 'resumeSession'
  | 'setSessionMode'
  | 'setSessionConfigOption'
  | 'prompt'
  | 'cancel'
  | 'unstable_forkSession'
  | 'closeSession'
> & {
  // Extension requests (`_session/steering`, `_session/async_task/stop`, …).
  // Optional: the native harness has no wire to carry one, and the engine only
  // calls it on connections whose harness advertised the matching extension.
  extMethod?: ClientSideConnection['extMethod']
  // ACP `authenticate`, sent after initialize for adapters with an
  // `authenticate` hook. Optional for the same reason: the native harness
  // has nothing to authenticate against.
  authenticate?: ClientSideConnection['authenticate']
}

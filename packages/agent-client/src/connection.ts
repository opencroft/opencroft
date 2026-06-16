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
  | 'resumeSession'
  | 'setSessionMode'
  | 'setSessionConfigOption'
  | 'prompt'
  | 'cancel'
  | 'unstable_forkSession'
>

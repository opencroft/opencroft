/**
 * `@opencroft/server/terminal` — running commands in a terminal context (a
 * node's or App's terminal, local or over ssh), and dispatching execution
 * contexts along the graph.
 */
import type { ExecOptions, ExecResult, ServerConfig, TerminalContext } from '@opencroft/terminal'
// Type-only: the job shapes live with the implementation, on the server entry. Nothing runtime
// crosses this import, and duplicating them here would be a second definition to drift.
import type { JobSession, JobSessionOptions } from '@opencroft/terminal/server'

export type { ExecOptions, ExecResult, JobSession, JobSessionOptions, ServerConfig, TerminalContext }

export interface HostTerminalApi {
  exec(ctx: TerminalContext, command: string): Promise<string>
  run(ctx: TerminalContext, args: string[], env?: Record<string, string>): Promise<string>
  execResult(ctx: TerminalContext, command: string, opts?: ExecOptions): Promise<ExecResult>
  runResult(ctx: TerminalContext, args: string[], opts?: ExecOptions): Promise<ExecResult>
  /** Resolve a terminal context from a node's output handle ("node-id" + "handle-id"). */
  getContext(nodeId: string, handleId: string): Promise<TerminalContext>
  /**
   * Start a command as a watchable session and get back the key a client attaches to. Use this
   * when the output has to appear WHILE the command runs; `execResult` is the right call when
   * only the outcome matters.
   *
   * **It adds no reach that `exec` and `run` do not already have.** The command is chosen by your
   * server code either way. What differs is delivery: instead of one result at the end, output
   * goes to a terminal session as it arrives, and the returned `sessionKey` is what authorises
   * attaching to that session.
   *
   * **So treat the key as the secret it is.** It is the entire authorisation to watch the job —
   * return it in the action's response to the client that asked, and do not write it into node
   * data or anywhere else a browser can read without having asked.
   *
   * A context with no non-pty streaming channel — anything but `local` and `ssh` today — is
   * refused by rejection, before a key exists. So a rejection means nothing started and there is
   * nothing for you to clean up.
   */
  startJob(ctx: TerminalContext, opts: JobSessionOptions): Promise<JobSession>
  /**
   * Stop a job you started with `stopWhenUnwatchedMs` (a job that exists only to be watched)
   * now, rather than when that bound runs out. Call it when your client is done with the view:
   * the tab showing it was closed, or it was replaced by another one. Until then every view holds
   * one of the ten job slots, so a client that lets go of views without this can fill them.
   *
   * A view that has already ended or been reclaimed is not an error. Any other job is refused
   * with a throw: a job started without the option, such as a deploy, is not stopped because a
   * viewer left.
   */
  stopViewJob(sessionKey: string): void
}

export interface HostSshApi {
  exec(config: ServerConfig, command: string): Promise<string>
  resolveKey(keyPath?: string): Promise<string | undefined>
}

export interface HostExecContextApi {
  /** Dispatch an execution-context event to every target connected to `sourceHandleId` on `sourceNodeId` (broadcast). `primary`'s shape is caller-defined -- narrow it at the call site. */
  dispatch(
    sourceNodeId: string,
    sourceHandleId: string,
    event: unknown,
  ): Promise<{ primary: unknown; results: unknown[] }>
}

export declare const terminal: HostTerminalApi
export declare const ssh: HostSshApi
export declare const execContext: HostExecContextApi

import type { ExecOptions, ExecResult, TerminalContext } from '../types'
import { getBackend } from './backend'

/** Structured exec: shell-interpreted `command`, identical `ExecResult` shape across backends. */
export async function terminalExecResult(
  ctx: TerminalContext,
  command: string,
  opts?: ExecOptions,
): Promise<ExecResult> {
  return getBackend(ctx).exec(ctx, command, opts)
}

/** Structured exec: argv form, no extra shell interpretation where the backend can avoid it. */
export async function terminalRunResult(ctx: TerminalContext, argv: string[], opts?: ExecOptions): Promise<ExecResult> {
  return getBackend(ctx).run(ctx, argv, opts)
}

function stdoutOrThrow(result: ExecResult): string {
  if (result.exitCode !== 0) {
    const detail = result.timedOut ? ' (timed out)' : ''
    const suffix = result.stderr ? `: ${result.stderr}` : ''
    throw new Error(`Command exited with code ${result.exitCode}${detail}${suffix}`)
  }
  return result.stdout
}

/** Back-compat: resolves with stdout, throws (message includes exit code + stderr) on non-zero exit. */
export async function terminalExec(ctx: TerminalContext, command: string): Promise<string> {
  return stdoutOrThrow(await terminalExecResult(ctx, command))
}

/** Back-compat: resolves with stdout, throws (message includes exit code + stderr) on non-zero exit. */
export async function terminalRun(ctx: TerminalContext, args: string[], env?: Record<string, string>): Promise<string> {
  return stdoutOrThrow(await terminalRunResult(ctx, args, env ? { env } : undefined))
}

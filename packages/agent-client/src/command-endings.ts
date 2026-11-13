// How a command really ended, for harnesses that settle every finished shell
// call as `completed` and say how it ended only inside the output text. Each
// reader answers for the one harness whose wording it matches (the adapter's
// `settleCompletedCall`), and nothing for output it does not recognise, so a
// changed wording reads as completed again rather than as something invented.

// The Copilot CLI ends a shell call's output with a line naming the exit code:
// `<shellId: 1 completed with exit code 3>` (measured on @github/copilot
// 1.0.95 over ACP, 2026-10-14: `exit 3` and `exit 0` both settle `completed`).
const COPILOT_SHELL_EXIT = /<shellId: [^>]* completed with exit code (\d+)>\s*$/

export function copilotCompletedCall(output: string): 'failed' | undefined {
  const match = output.match(COPILOT_SHELL_EXIT)
  return match && Number(match[1]) !== 0 ? 'failed' : undefined
}

// OpenCode settles a bash call that a Stop aborted as `completed`, with
// `<shell_metadata>\nUser aborted the command\n</shell_metadata>` at the end
// of its output (measured on opencode-ai over ACP, 2026-10-14). It reports no
// exit code at all, so a command that exits non-zero cannot be told from one
// that succeeded.
const OPENCODE_ABORTED = /<shell_metadata>\s*User aborted the command\s*<\/shell_metadata>\s*$/

export function opencodeCompletedCall(output: string): 'cancelled' | undefined {
  return OPENCODE_ABORTED.test(output) ? 'cancelled' : undefined
}

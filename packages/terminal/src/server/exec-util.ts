/** Shared helpers for building shell-safe commands and collecting bounded process output. */

export const DEFAULT_TIMEOUT_MS = 120_000
export const DEFAULT_MAX_OUTPUT_BYTES = 5 * 1024 * 1024

/** Quote a single argument for a POSIX shell. */
export function shellQuote(value: string): string {
  return `'${value.replace(/'/g, "'\\''")}'`
}

/** Join argv into a POSIX shell command line, quoting only where needed. */
export function shellJoin(args: string[]): string {
  return args
    .map((arg) => {
      if (/^[\w./:@=,-]+$/.test(arg)) {
        return arg
      }
      return shellQuote(arg)
    })
    .join(' ')
}

/**
 * Build the injection for `env`: a POSIX-sh-safe preamble that reads each value (base64, one
 * per line) off stdin and exports it under its name, plus the exact stdin bytes that preamble
 * expects, in the same order. The preamble text carries only secret NAMES -- already treated as
 * non-sensitive everywhere in this codebase -- never a value; every value crosses the process
 * boundary via stdin instead of argv. `ps`/`pgrep -fa` (and anything else that reads a process's
 * command line, e.g. /proc/<pid>/cmdline) expose only the argv a process was started with, never
 * the bytes written to its stdin pipe -- so a value that only ever travels over stdin cannot
 * appear there, for the lifetime of the process, not just on failure. The previous approach here
 * (`export K=$(echo <base64> | base64 -d)`, spliced directly into the command string) put the
 * base64 text itself in argv; encoding a value differently on the command line is the same defect
 * with a longer word. Base64 is kept only as a transport encoding (stdin is line-oriented here,
 * and a raw value may contain newlines) -- it carries no protective weight on its own.
 */
export function buildEnvInjection(env?: Record<string, string>): { preamble: string; stdin: Buffer | undefined } {
  const entries = Object.entries(env ?? {})
  if (entries.length === 0) {
    return { preamble: '', stdin: undefined }
  }
  const preamble = entries
    .map(([key]) => `IFS= read -r __v; export ${key}="$(printf '%s' "$__v" | base64 -d)"; `)
    .join('')
  const stdin = Buffer.from(
    entries.map(([, value]) => `${Buffer.from(value, 'utf8').toString('base64')}\n`).join(''),
    'utf8',
  )
  return { preamble, stdin }
}

/** Prefix a shell command with a `cd <cwd> &&` when a cwd is set. */
export function cdPrefix(cwd?: string): string {
  return cwd ? `cd ${shellQuote(cwd)} && ` : ''
}

const SUMMARY_MAX_CHARS = 120

/**
 * Build a safe, single-line summary of a command for logging: just the first line, truncated,
 * with a `(+N more lines)` marker when the command is multi-line. Full command/script bodies
 * (which may contain heredocs, injected env values, or other secret material — e.g. an SSH
 * private key piped in via a key-injection script) must never be logged verbatim.
 */
export function summarizeCommand(cmd: string, args: string[] = []): string {
  const full = args.length > 0 ? `${cmd} ${args.join(' ')}` : cmd
  const lines = full.split('\n')
  const firstLine = lines[0] ?? ''
  const extraLines = lines.length - 1
  const truncated = firstLine.length > SUMMARY_MAX_CHARS ? `${firstLine.slice(0, SUMMARY_MAX_CHARS)}…` : firstLine
  return extraLines > 0 ? `${truncated} … (+${extraLines} more lines)` : truncated
}

/** Accumulates a byte-capped stream, truncating (not erroring) once the cap is hit. */
export class OutputCollector {
  private readonly chunks: Buffer[] = []
  private bytes = 0
  truncated = false

  constructor(private readonly maxBytes: number) {}

  push(chunk: Buffer): void {
    if (this.bytes >= this.maxBytes) {
      this.truncated = true
      return
    }
    const remaining = this.maxBytes - this.bytes
    const slice = chunk.length > remaining ? chunk.subarray(0, remaining) : chunk
    if (slice.length < chunk.length) {
      this.truncated = true
    }
    this.chunks.push(slice)
    this.bytes += slice.length
  }

  toString(): string {
    return Buffer.concat(this.chunks).toString('utf8')
  }
}

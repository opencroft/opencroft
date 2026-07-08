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
 * Build a `export K=$(echo <base64> | base64 -d) && ...` prefix that injects env vars into a
 * remote shell command without quoting hazards. Empty/undefined env yields an empty string.
 */
export function envPrefix(env?: Record<string, string>): string {
  if (!env || Object.keys(env).length === 0) {
    return ''
  }
  const exports = Object.entries(env)
    .map(([key, value]) => `export ${key}=$(echo ${Buffer.from(value, 'utf8').toString('base64')} | base64 -d)`)
    .join(' && ')
  return `${exports} && `
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

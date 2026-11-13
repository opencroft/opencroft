// Extra request headers a selection sends to its provider endpoint (see
// AgentSelection.headers), and the shapes harnesses take them in.
//
// Client-safe: imported by resolve.ts, which client components load.

import { ActionRequiredError } from './errors'

// RFC 9110 field-name: a token.
const HEADER_NAME = /^[!#$%&'*+.^_`|~0-9A-Za-z-]+$/

// A header value may not hold a line break or another control character: in
// an env var of `Name: Value` lines a newline would start a header of its own.
// Horizontal tab is allowed, as HTTP allows it.
// biome-ignore lint/suspicious/noControlCharactersInRegex: matching control characters is the point
const BAD_VALUE = /[\u0000-\u0008\u000a-\u001f\u007f]/

// Refuses a header a harness could not send as it is, naming it, before
// anything is spawned or requested.
export function checkEndpointHeaders(headers: Record<string, string> | undefined): void {
  for (const [name, value] of Object.entries(headers ?? {})) {
    if (!HEADER_NAME.test(name)) {
      throw new ActionRequiredError(`The request header name "${name}" on the agent profile is not a valid header name.`)
    }
    if (BAD_VALUE.test(value)) {
      throw new ActionRequiredError(
        `The request header "${name}" on the agent profile has a line break or a control character in its value.`,
      )
    }
  }
}

// `extra` over `base`. Header names are case-insensitive on the wire but object
// keys are not, so a key of `base` differing only in case is dropped first:
// otherwise a custom `authorization` would sit beside the Bearer shorthand
// instead of replacing it, and the endpoint would receive both.
export function mergeHeaders(
  base: Record<string, string>,
  extra: Record<string, string> | undefined,
): Record<string, string> {
  const merged = { ...base }
  for (const [name, value] of Object.entries(extra ?? {})) {
    for (const existing of Object.keys(merged)) {
      if (existing.toLowerCase() === name.toLowerCase()) {
        delete merged[existing]
      }
    }
    merged[name] = value
  }
  return merged
}

// The headers as `Name: Value` lines, the form Claude Code reads from
// ANTHROPIC_CUSTOM_HEADERS.
export function headerLines(headers: Record<string, string>): string {
  return Object.entries(headers)
    .map(([name, value]) => `${name}: ${value}`)
    .join('\n')
}

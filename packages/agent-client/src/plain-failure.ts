// Client-safe: pure helper, no node:* imports.
//
// A failure as a person reads it: one line on what happened, one on what they
// can do, and the technical text kept apart for whoever wants it. The text a
// failure arrives with is written for a log (a harness's stderr, a socket
// error code, a JSON-RPC message), and a chat that shows it as the main line
// leaves the reader to decode it.
//
// Matched on the text because the text is the evidence: a harness's stderr
// and a provider's refusal reach this process as words, not as types. The
// rules cover the causes a reader can act on; anything else keeps its own
// text, so a failure no rule knows is never reworded into a wrong one.
//
// Each rule reads one producer's text and is anchored to the shape that
// producer writes, since the same words mean other things elsewhere: "node"
// is also a graph node, ECONNREFUSED also an MCP server's socket. Text this
// engine wrote for a person (a refusal, a report) keeps its words; the one
// cause it states in an engine's terms, a session it no longer holds, is the
// only rule that reads it.

/** When the failure happened, which decides the wording when no rule matches. */
export type FailureMoment = 'start' | 'send' | 'turn'

/**
 * Who wrote the text:
 * - `harness`: the harness process or its model provider (stderr at start, a
 *   refused ACP call);
 * - `engine`: this engine or its host, already worded for the reader.
 */
export type FailureSource = 'harness' | 'engine'

export interface PlainFailure {
  /** What happened, in plain words. */
  title: string
  /** What the person can do about it. */
  hint?: string
  /** The text the failure came with, when the title is not that text. */
  details?: string
}

interface Rule {
  from: readonly FailureSource[]
  test: (text: string) => boolean
  title: string
  hint: string
}

// The shell's own words for a launcher it could not find: "sh: 1: exec: npx:
// not found", "bash: node: command not found", "spawn npx ENOENT", and env's
// "env: 'node': No such file or directory" from a `#!/usr/bin/env node`
// script. The command is a word of its own followed by a colon, so a sentence
// that merely says "node" does not match.
const LAUNCHER_MISSING =
  /(^|[\s:;])(npx|node): (command )?not found\b|\bspawn (npx|node) ENOENT\b|\benv: ['‘"]?(npx|node)['’"]?: No such file or directory/i

// A provider refusing the key, as the harnesses relay it: an HTTP 401 next to
// the provider's word for it ("401 Unauthorized", "API Error: 401
// {…authentication_error…}", "status code 401"), or the provider's sentence for
// a bad key.
const KEY_REJECTED =
  /\b401\b[^\n]{0,80}\b(unauthori[sz]ed|authentication_error|api[ _-]?key)\b|\b(status( code)?|error code|API Error)[: ]*401\b|\binvalid[ _-]?(x-)?api[ _-]?key\b|\bincorrect api key\b|\bauthentication_error\b/i

// A model endpoint that did not answer, as a provider client reports it: the
// socket's connect or DNS failure, fetch's own "fetch failed", and the
// harnesses' sentences for it. A harness's report about one of its MCP
// servers names the server and can carry the same socket words; it is the
// harness's report about that server, not about the model.
const SERVER_UNREACHABLE =
  /\bconnect (ECONNREFUSED|ETIMEDOUT|EHOSTUNREACH|ENETUNREACH)\b|\bgetaddrinfo (ENOTFOUND|EAI_AGAIN)\b|\bfetch failed\b|\bConnection error\b|\bUnable to connect to API\b|\berror sending request for url\b/i
const MCP = /\bMCP\b/i

// The session is gone from where it was held: the engine's own "Unknown
// session: <id>" after a restart emptied it, and a harness's "Session not
// found" for one it was never told about again.
const SESSION_LOST_BY = {
  engine: /^Unknown session: /,
  harness: /\bSession not found\b/,
} as const

// Ordered: the first rule that matches wins. A missing launcher comes first
// because its stderr can carry other words of failure after it; a refused key
// before an unreachable server because a provider's 401 can carry a
// connection word in its body.
const RULES: readonly Rule[] = [
  {
    from: ['harness'],
    test: (text) => LAUNCHER_MISSING.test(text),
    title: "The agent couldn't start: Node.js isn't installed where it runs.",
    hint: 'Install Node.js (with npx) there, or put it on the PATH, then try again.',
  },
  {
    from: ['harness'],
    test: (text) => KEY_REJECTED.test(text),
    title: "The model provider didn't accept the agent's key.",
    hint: "Check the key on the agent's profile, then try again.",
  },
  {
    from: ['harness'],
    test: (text) => SERVER_UNREACHABLE.test(text) && !MCP.test(text),
    title: "The agent's model server can't be reached.",
    hint: 'Check that the server is running and reachable from where the agent runs, then try again.',
  },
  {
    from: ['engine', 'harness'],
    test: (text) => SESSION_LOST_BY.engine.test(text) || SESSION_LOST_BY.harness.test(text),
    title: "The agent's session was lost, most likely in a server restart.",
    hint: 'Try again to start a new one; the conversation so far is kept.',
  },
]

// The wording when no rule matches. A failed start and a failed send say what
// did not happen, with the text under Details; a failure inside a turn keeps
// its own text, since it is often a plain report already ("MCP server not
// connected: …").
const FALLBACK: Record<Exclude<FailureMoment, 'turn'>, { title: string; hint: string }> = {
  start: { title: "The agent couldn't start.", hint: 'Try again. If it keeps failing, Details say why.' },
  send: { title: "Your message wasn't sent.", hint: "It's back in the composer; send it again." },
}

/**
 * The plain reading of a failure's text when a rule for its producer knows
 * the cause, with the text under details; undefined when none does.
 */
export function knownFailure(text: string, source: FailureSource): PlainFailure | undefined {
  const raw = text.trim()
  const rule = RULES.find((candidate) => candidate.from.includes(source) && candidate.test(raw))
  return rule ? { title: rule.title, hint: rule.hint, details: raw } : undefined
}

/** The plain-language reading of a failure's text. */
export function plainFailure(text: string, moment: FailureMoment, source: FailureSource): PlainFailure {
  const raw = text.trim()
  const known = knownFailure(raw, source)
  if (known) {
    return known
  }
  if (moment === 'turn') {
    return { title: raw || 'The agent reported an error.' }
  }
  return { ...FALLBACK[moment], ...(raw ? { details: raw } : {}) }
}

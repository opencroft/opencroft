// Regular expressions in RE2's syntax, matched by `re2js`, a JavaScript port
// of RE2: matching takes time linear in the text whatever the pattern, so a
// pattern such as `(a+)+$` cannot stall the process that resolves a graph.
// The price is RE2's syntax: no backreferences and no lookaround. The canvas
// and the server run this same module, so a card shows what a run computes.
//
// A compiled pattern is kept by its text (`cachedParse`) and remembers its
// last search and replacement, so a node's several outputs read one match.

import { RE2JS } from 're2js'

import { cachedParse } from './parse-cache'

/** The longest pattern a node takes, in characters. */
export const MAX_PATTERN_LENGTH = 1000

/** The most capture groups a pattern may have. */
export const MAX_PATTERN_GROUPS = 32

/** A capture group of a pattern: its number, from 1 in the order of its `(`, and its name when it has one. */
export interface PatternGroup {
  number: number
  name?: string
}

/** The first match of a pattern in a text. */
export interface PatternMatch {
  /** The text matched. */
  text: string
  /** The text of each group, in the order of `groups`; empty for a group that took no part in the match. */
  groups: string[]
}

export type ReplaceResult = { ok: true; text: string; count: number } | { ok: false; error: string }

export interface Pattern {
  /** The capture groups, in order. */
  groups: PatternGroup[]
  /** The first match in `text`, or null when there is none. */
  search(text: string): PatternMatch | null
  /**
   * `text` with each match (`all`) or the first one replaced by
   * `replacement`, in which `$1` to `$99` and `$<name>` stand for a group,
   * `$&` for the whole match and `$$` for a dollar sign; any other `$` is
   * itself. A reference to a group the pattern does not have is an error.
   */
  replace(text: string, replacement: string, all: boolean): ReplaceResult
}

export type CompiledPattern = { ok: true; pattern: Pattern } | { ok: false; error: string }

const GROUP_NAME = /^[A-Za-z_][A-Za-z0-9_]*$/

/**
 * `source` compiled, matching letters in either case when `ignoreCase`, or why
 * it does not compile: it is empty, longer than `MAX_PATTERN_LENGTH`, not RE2
 * syntax (a backreference or a lookaround is named as not supported), has a
 * group name that is not a letter or `_` followed by letters, digits and `_`,
 * or has more than `MAX_PATTERN_GROUPS` groups. Compiled once per distinct
 * pattern and reused (`cachedParse`).
 */
export function compilePattern(source: string, ignoreCase: boolean): CompiledPattern {
  return cachedParse(`pattern:${ignoreCase ? 'i' : 'c'}:${source}`, () => compile(source, ignoreCase))
}

function compile(source: string, ignoreCase: boolean): CompiledPattern {
  if (source === '') {
    return { ok: false, error: 'The pattern is empty' }
  }
  if (source.length > MAX_PATTERN_LENGTH) {
    return { ok: false, error: `The pattern is longer than ${MAX_PATTERN_LENGTH} characters` }
  }
  let re: RE2JS
  try {
    re = RE2JS.compile(source, ignoreCase ? RE2JS.CASE_INSENSITIVE : 0)
  } catch (error) {
    return { ok: false, error: syntaxError(error instanceof Error ? error.message : String(error)) }
  }
  const count = re.groupCount()
  if (count > MAX_PATTERN_GROUPS) {
    return { ok: false, error: `The pattern has ${count} groups, more than ${MAX_PATTERN_GROUPS}` }
  }
  const names = new Map<number, string>()
  for (const [name, number] of Object.entries(re.namedGroups())) {
    if (!GROUP_NAME.test(name)) {
      return { ok: false, error: `"${name}" is not a group name: start it with a letter or _` }
    }
    names.set(number, name)
  }
  const groups = Array.from({ length: count }, (_, i): PatternGroup => {
    const name = names.get(i + 1)
    return name === undefined ? { number: i + 1 } : { number: i + 1, name }
  })
  return { ok: true, pattern: patternOf(re, groups) }
}

// The engine's message without its prefix, or what the pattern uses that RE2
// leaves out. RE2 reads `\1` as an unknown escape and `(?<=` as a bad group
// name, so both are recognised from the fragment the message quotes.
function syntaxError(message: string): string {
  const reason = message.replace(/^error parsing regexp: /, '')
  if (/^invalid escape sequence: `\\[1-9k]/.test(reason)) {
    return 'Backreferences such as \\1 are not supported: the pattern is matched in linear time, which they would break'
  }
  if (/`\(\?<?[=!]/.test(reason)) {
    return 'Lookaround such as (?=…) or (?<=…) is not supported: the pattern is matched in linear time, which it would break'
  }
  return reason.charAt(0).toUpperCase() + reason.slice(1)
}

function patternOf(re: RE2JS, groups: PatternGroup[]): Pattern {
  // The last search and the last replacement, for the next read of the same
  // node's other outputs.
  let searched: { text: string; match: PatternMatch | null } | undefined
  let replaced: { text: string; replacement: string; all: boolean; result: ReplaceResult } | undefined

  const search = (text: string): PatternMatch | null => {
    if (searched?.text !== text) {
      const m = re.matcher(text)
      const match = m.find() ? { text: m.group() ?? '', groups: groups.map((g) => m.group(g.number) ?? '') } : null
      searched = { text, match }
    }
    return searched.match
  }

  const replace = (text: string, replacement: string, all: boolean): ReplaceResult => {
    if (replaced?.text !== text || replaced.replacement !== replacement || replaced.all !== all) {
      replaced = { text, replacement, all, result: replaceIn(re, groups, text, replacement, all) }
    }
    return replaced.result
  }

  return { groups, search, replace }
}

function replaceIn(re: RE2JS, groups: PatternGroup[], text: string, replacement: string, all: boolean): ReplaceResult {
  const parts = parseReplacement(replacement, groups)
  if (!Array.isArray(parts)) {
    return { ok: false, error: parts.error }
  }
  const m = re.matcher(text)
  let out = ''
  let from = 0
  let count = 0
  while (m.find()) {
    out += text.slice(from, m.start())
    for (const part of parts) {
      out += typeof part === 'string' ? part : (m.group(part) ?? '')
    }
    from = m.end()
    count++
    if (!all) {
      break
    }
  }
  return { ok: true, text: out + text.slice(from), count }
}

/** A replacement as literal texts and group numbers (0 for the whole match). */
type ReplacementPart = string | number

function parseReplacement(replacement: string, groups: PatternGroup[]): ReplacementPart[] | { error: string } {
  const parts: ReplacementPart[] = []
  let literal = ''
  const push = (part: number) => {
    if (literal) {
      parts.push(literal)
      literal = ''
    }
    parts.push(part)
  }
  let i = 0
  while (i < replacement.length) {
    const ch = replacement[i]
    const next = replacement[i + 1]
    if (ch !== '$' || next === undefined) {
      literal += ch
      i++
    } else if (next === '$') {
      literal += '$'
      i += 2
    } else if (next === '&') {
      push(0)
      i += 2
    } else if (next >= '1' && next <= '9') {
      // Two digits when they name a group, as `$12` does with twelve groups;
      // otherwise one digit, and the second is text.
      const two = Number(replacement.slice(i + 1, i + 3))
      const number = /^\d\d$/.test(replacement.slice(i + 1, i + 3)) && two <= groups.length ? two : Number(next)
      if (number > groups.length) {
        return { error: `$${number}: the pattern has ${groupCount(groups.length)}` }
      }
      push(number)
      i += 1 + String(number).length
    } else if (next === '<' && replacement.indexOf('>', i + 2) !== -1) {
      const close = replacement.indexOf('>', i + 2)
      const name = replacement.slice(i + 2, close)
      const group = groups.find((g) => g.name === name)
      if (!group) {
        return { error: `$<${name}>: the pattern has no group named "${name}"` }
      }
      push(group.number)
      i = close + 1
    } else {
      literal += ch
      i++
    }
  }
  if (literal) {
    parts.push(literal)
  }
  return parts
}

function groupCount(n: number): string {
  if (n === 0) {
    return 'no groups'
  }
  return n === 1 ? '1 group' : `${n} groups`
}

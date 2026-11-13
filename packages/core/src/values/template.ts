// The one template syntax: `{name}` and `{name:format}`, with `{{` and `}}`
// for literal braces. Format and file-name templates both use it.

import { cachedParse } from './parse-cache'
import { type PrimitiveValue, valueAsText } from './types'

/** A placeholder of a template. `at` is the 1-based position of its `{`. */
export interface TemplatePlaceholder {
  name: string
  format?: string
  at: number
}

/** A mistake in a template, and the 1-based position of the character at fault. */
export interface TemplateError {
  /** Says what and where: `Unknown format "x" at 7`. */
  message: string
  position: number
}

export interface ParsedTemplate {
  /** Every placeholder, in order. */
  placeholders: TemplatePlaceholder[]
  /** The distinct placeholder names, in order of first appearance. */
  names: string[]
  errors: TemplateError[]
}

export type FormatTemplateResult = { ok: true; text: string } | { ok: false; error: string }

type Segment = { text: string } | TemplatePlaceholder

const NAME = /^[A-Za-z_][A-Za-z0-9_]*$/
const PAD = /^0(\d+)$/
const FIXED = /^\.(\d+)f$/
const DATE_TOKENS = /YYYY|MM|DD|HH|mm|ss/g
const MAX_PAD = 64
const MAX_DECIMALS = 100

type Format = { kind: 'pad'; width: number } | { kind: 'fixed'; decimals: number } | { kind: 'date'; pattern: string }

/**
 * What a format names, or null when it is none of: `0N`, a number padded with
 * zeros to N digits; `.Nf`, a number with N decimals; a date pattern, made of
 * `YYYY MM DD HH mm ss` and characters other than letters.
 */
function formatOf(format: string): Format | null {
  const pad = PAD.exec(format)
  if (pad) {
    const width = Number(pad[1])
    return width >= 1 && width <= MAX_PAD ? { kind: 'pad', width } : null
  }
  const fixed = FIXED.exec(format)
  if (fixed) {
    const decimals = Number(fixed[1])
    return decimals <= MAX_DECIMALS ? { kind: 'fixed', decimals } : null
  }
  const tokens = format.match(DATE_TOKENS)
  if (tokens && !/[A-Za-z]/.test(format.replace(DATE_TOKENS, ''))) {
    return { kind: 'date', pattern: format }
  }
  return null
}

function scan(template: string): { segments: Segment[]; errors: TemplateError[] } {
  const segments: Segment[] = []
  const errors: TemplateError[] = []
  const error = (reason: string, at: number) => errors.push({ message: `${reason} at ${at}`, position: at })
  let text = ''
  let i = 0
  while (i < template.length) {
    const ch = template[i]
    if ((ch === '{' || ch === '}') && template[i + 1] === ch) {
      text += ch
      i += 2
      continue
    }
    if (ch === '}') {
      error('Unmatched "}"', i + 1)
      i++
      continue
    }
    if (ch !== '{') {
      text += ch
      i++
      continue
    }
    const close = template.indexOf('}', i + 1)
    const open = template.indexOf('{', i + 1)
    if (close === -1 || (open !== -1 && open < close)) {
      error('Unclosed "{"', i + 1)
      i++
      continue
    }
    const at = i + 1
    const body = template.slice(i + 1, close)
    const colon = body.indexOf(':')
    const name = colon === -1 ? body : body.slice(0, colon)
    const format = colon === -1 ? undefined : body.slice(colon + 1)
    i = close + 1
    if (!NAME.test(name)) {
      error(name === '' ? 'A placeholder needs a name' : `"${name}" is not a placeholder name`, at)
      continue
    }
    if (format !== undefined && formatOf(format) === null) {
      error(`Unknown format "${format}"`, at)
      continue
    }
    if (text) {
      segments.push({ text })
      text = ''
    }
    segments.push(format === undefined ? { name, at } : { name, format, at })
  }
  if (text) {
    segments.push({ text })
  }
  return { segments, errors }
}

// A template scanned, and what `parseTemplate` reads of it, kept by its text
// (`cachedParse`): a Format's handles, output and checks scan it once.
function scanned(template: string): { segments: Segment[]; parsed: ParsedTemplate } {
  return cachedParse(`template:${template}`, () => {
    const { segments, errors } = scan(template)
    const placeholders = segments.filter((segment): segment is TemplatePlaceholder => 'name' in segment)
    return { segments, parsed: { placeholders, names: [...new Set(placeholders.map((p) => p.name))], errors } }
  })
}

/**
 * A template's placeholders and mistakes, for a live preview. Kept by its
 * text and reused (`cachedParse`): the answer is shared, and not to be changed.
 */
export function parseTemplate(template: string): ParsedTemplate {
  return scanned(template).parsed
}

/**
 * The template's text with every placeholder replaced by its value from
 * `values`, formatted as it says. An error names the first mistake: one in the
 * template (see `parseTemplate`), a placeholder with no value, or a value its
 * format does not take. A date format reads epoch milliseconds or an ISO
 * string and writes the date in UTC. `defaultFormats` gives, by name, the
 * format a placeholder written without one takes (`{date}` read as
 * `{date:YYYY-MM-DD}`); it must be a format `parseTemplate` accepts.
 */
export function formatTemplate(
  template: string,
  values: Readonly<Record<string, unknown>>,
  defaultFormats: Readonly<Record<string, string>> = {},
): FormatTemplateResult {
  const { segments, parsed } = scanned(template)
  const { errors } = parsed
  if (errors.length > 0) {
    return { ok: false, error: errors[0].message }
  }
  let text = ''
  for (const segment of segments) {
    if ('text' in segment) {
      text += segment.text
      continue
    }
    const value = Object.hasOwn(values, segment.name) ? values[segment.name] : undefined
    const fallback = Object.hasOwn(defaultFormats, segment.name) ? defaultFormats[segment.name] : undefined
    const formatted = formatValue(segment.format === undefined ? { ...segment, format: fallback } : segment, value)
    if (!formatted.ok) {
      return formatted
    }
    text += formatted.text
  }
  return { ok: true, text }
}

function formatValue(placeholder: TemplatePlaceholder, value: unknown): FormatTemplateResult {
  const shown = `{${placeholder.name}${placeholder.format === undefined ? '' : `:${placeholder.format}`}}`
  if (value === undefined || value === null) {
    return { ok: false, error: `Nothing to put in ${shown}` }
  }
  const format = placeholder.format === undefined ? null : formatOf(placeholder.format)
  if (!format) {
    return isPrimitive(value)
      ? { ok: true, text: valueAsText(value) }
      : { ok: false, error: `${shown} takes text, a number or true / false` }
  }
  if (format.kind === 'date') {
    const date = typeof value === 'number' || typeof value === 'string' ? new Date(value) : null
    if (!date || Number.isNaN(date.getTime())) {
      return { ok: false, error: `${shown} takes a date: epoch milliseconds or an ISO string` }
    }
    return { ok: true, text: formatDate(date, format.pattern) }
  }
  const n = typeof value === 'number' ? value : typeof value === 'string' && value.trim() !== '' ? Number(value) : NaN
  if (!Number.isFinite(n)) {
    return { ok: false, error: `${shown} takes a number` }
  }
  if (format.kind === 'fixed') {
    return { ok: true, text: n.toFixed(format.decimals) }
  }
  const whole = Math.round(n)
  const digits = String(Math.abs(whole)).padStart(format.width, '0')
  return { ok: true, text: whole < 0 ? `-${digits}` : digits }
}

function formatDate(date: Date, pattern: string): string {
  const two = (n: number) => String(n).padStart(2, '0')
  const parts: Record<string, string> = {
    YYYY: String(date.getUTCFullYear()).padStart(4, '0'),
    MM: two(date.getUTCMonth() + 1),
    DD: two(date.getUTCDate()),
    HH: two(date.getUTCHours()),
    mm: two(date.getUTCMinutes()),
    ss: two(date.getUTCSeconds()),
  }
  return pattern.replace(DATE_TOKENS, (token) => parts[token])
}

function isPrimitive(value: unknown): value is PrimitiveValue {
  return (
    typeof value === 'string' || typeof value === 'boolean' || (typeof value === 'number' && Number.isFinite(value))
  )
}

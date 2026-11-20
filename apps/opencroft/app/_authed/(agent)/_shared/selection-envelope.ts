// What a surface's selection says: the quote the reader sees above the
// composer, and the block the agent receives with the message.
//
// A surface publishes a list of items, each a reference an agent resolves with
// one existing tool call. This module turns that list into the pair the
// selection scope holds, `{label, content}`, once, when the selection is
// published: the scope, the cross-window channel and the send path carry the
// pair unchanged.
//
// THE QUOTE IS A PATH, `Space › Place › what`. Its parts are joined with ` › `
// on the wire, and the block's first line is that same quote, so a delivered
// message reads its quote back from its own text (`splitQuote`) and shows what
// the composer showed. The width decides only how much of the path is drawn.
//
// THE HOST WRITES THE CALLS. Each item's kind and fields decide its `Read:`
// line, so no publisher writes tool syntax by hand. Content is never inlined,
// except highlighted text, under a cap: the text of a line range, or text the
// surface could not place on a line (a highlight in an editor, say).
//
// EVERY PUBLISHER STRING IS DATA. Item fields reach the block on one line each
// (`oneLine`), so no field can start a line of its own, such as a `Read:` line;
// call arguments are JSON; shell arguments are quoted after `--`; and a commit
// id is used only when it is 4 to 64 hex digits, since it is the one argument written bare.
//
// No React and no host imports: the composer, the transcript and their tests
// all read it.

/** A range of lines, 1-based and inclusive. */
export interface LineRange {
  from: number
  to: number
}

/** One thing the reader has selected or open, as a reference an agent can resolve. */
export type SelectionItem =
  | {
      kind: 'node'
      /** The graph's address, `<space>.<graph>`. */
      graph: string
      id: string
      name: string
      type: string
    }
  | {
      kind: 'file'
      /** A `remote_*` target: `<node-id>/<handle-id>`, or `<app address or uuid>/<handle-id>`. */
      terminal: string
      /** Absolute, or relative to the terminal's working directory. */
      path: string
      folder?: boolean
      lines?: LineRange
      /** The highlighted text: of `lines` when given, otherwise text the surface can't place on a line. */
      text?: string
      /** The terminal's name as the host shows it. */
      on?: string
    }
  | {
      kind: 'commit'
      terminal: string
      /** The repository's folder on the terminal; absent = the terminal's own checkout. */
      repository?: string
      sha: string
      subject?: string
      /** A file of the commit, whose change the call shows. */
      path?: string
    }
  | {
      kind: 'app'
      /** The App's address, `<space>.<slug>`. */
      app: string
      action: string
      params: Record<string, unknown>
      name: string
      /** What the item is called in counts, singular and plural. Default: item, items. */
      noun?: [singular: string, plural: string]
      lines?: LineRange
      text?: string
    }

/** What a surface publishes: its items, and where the reader is. */
export interface Selection {
  items: SelectionItem[]
  /** Where the reader is, for the quote: the graph's or App's name. Default: the App's name. */
  place?: string
}

/** The composed selection: what the quote shows and what the agent receives. */
export interface ComposedSelection {
  label: string
  content: string
}

/** The separator between a quote's parts, on the wire and in a hover hint. */
export const QUOTE_SEPARATOR = ' › '

/** At most this many items are listed; the quote still counts every one. */
export const MAX_LISTED_ITEMS = 100

/** The highlighted text a selection carries, in characters, across all its items. */
export const MAX_QUOTED_CHARACTERS = 4000

/** The longest *what* a quote shows; the transcript's chip label is cut at the same length. */
export const MAX_WHAT_LENGTH = 80

/**
 * A published value that is a `Selection` rather than the deprecated
 * `{label, content}` pair. Extensions publish it, so the check reads own
 * properties rather than trusting the type.
 */
export function isSelection(value: unknown): value is Selection {
  return (
    typeof value === 'object' &&
    value !== null &&
    Object.hasOwn(value, 'items') &&
    Array.isArray((value as Selection).items)
  )
}

/**
 * The quote and the block for `selection`, read in `space` with `place` as
 * where the reader is when the selection names no place of its own. Null for
 * a selection with no items: there is nothing to quote.
 */
export function describeSelection(
  selection: Selection,
  where: { space?: string; place?: string },
): ComposedSelection | null {
  const { items } = selection
  if (items.length === 0) {
    return null
  }
  const label = [where.space, selection.place ?? where.place, whatOf(items)]
    .filter((part): part is string => Boolean(part))
    .map(oneLine)
    .join(QUOTE_SEPARATOR)
  const listed = items.slice(0, MAX_LISTED_ITEMS)
  const lines = [label, ...blockLines(listed)]
  if (items.length > listed.length) {
    lines.push(`and ${items.length - listed.length} more not listed`)
  }
  return { label, content: lines.join('\n') }
}

/**
 * A quote's first line split into where it was made and what it names: the
 * first two separators divide the space, the place and the *what*, and the
 * *what* keeps any further separator. A line without two separators has no
 * place: a quote with no path, such as a deprecated `{label, content}`
 * publisher's label.
 */
export function splitQuote(line: string): { place?: [space: string, app: string]; what: string } {
  const first = line.indexOf(QUOTE_SEPARATOR)
  const second = first < 0 ? -1 : line.indexOf(QUOTE_SEPARATOR, first + QUOTE_SEPARATOR.length)
  if (second < 0) {
    return { what: line }
  }
  return {
    place: [line.slice(0, first), line.slice(first + QUOTE_SEPARATOR.length, second)],
    what: line.slice(second + QUOTE_SEPARATOR.length),
  }
}

function whatOf(items: readonly SelectionItem[]): string {
  return cut(oneLine(items.length === 1 ? whatOfOne(items[0]) : whatOfMany(items)), MAX_WHAT_LENGTH)
}

function whatOfOne(item: SelectionItem): string {
  switch (item.kind) {
    case 'node':
      return item.name || item.id
    case 'file': {
      const name = baseName(item.path)
      if (item.folder) {
        // The root's name is already its slash.
        return name.endsWith('/') ? name : `${name}/`
      }
      return item.lines ? linesSelected(item.lines, name) : name
    }
    case 'commit':
      return [item.sha.slice(0, 7), item.subject].filter(Boolean).join(' ')
    case 'app':
      return item.lines ? linesSelected(item.lines, item.name) : item.name
  }
}

function whatOfMany(items: readonly SelectionItem[]): string {
  const plurals = new Set(items.map((item) => nounOf(item)[1]))
  const [plural] = plurals
  return `${items.length} ${plurals.size === 1 ? plural : 'items'} selected`
}

function nounOf(item: SelectionItem): [string, string] {
  switch (item.kind) {
    case 'node':
      return ['node', 'nodes']
    case 'file':
      return item.folder ? ['folder', 'folders'] : ['file', 'files']
    case 'commit':
      return ['commit', 'commits']
    case 'app':
      return item.noun ?? ['item', 'items']
  }
}

function linesSelected(lines: LineRange, name: string): string {
  const count = lines.to - lines.from + 1
  return `${count} ${count === 1 ? 'line' : 'lines'} selected in ${name}`
}

/**
 * One line per item and one `Read:` line per call. Nodes on one graph share
 * one call, written after the last of them where their graph first appears;
 * every other item has its own call under its line.
 */
function blockLines(items: readonly SelectionItem[]): string[] {
  const out: string[] = []
  const budget = { left: MAX_QUOTED_CHARACTERS }
  const graphsDone = new Set<string>()
  for (const item of items) {
    if (item.kind === 'node') {
      if (graphsDone.has(item.graph)) {
        continue
      }
      graphsDone.add(item.graph)
      const onGraph = items.filter(
        (other): other is Extract<SelectionItem, { kind: 'node' }> =>
          other.kind === 'node' && other.graph === item.graph,
      )
      for (const node of onGraph) {
        out.push(`Node "${oneLine(node.name || node.id)}" (${oneLine(node.type)}), id ${oneLine(node.id)}`)
      }
      out.push(
        read('app_call', { app: item.graph, action: 'getNodes', params: { nodeIds: onGraph.map((node) => node.id) } }),
      )
      continue
    }
    out.push(itemLine(item), callOf(item) ?? NO_CALL)
    if ((item.kind === 'file' || item.kind === 'app') && item.text) {
      out.push(...quoted(item.lines, item.text, budget))
    }
  }
  return out
}

function itemLine(item: Exclude<SelectionItem, { kind: 'node' }>): string {
  switch (item.kind) {
    case 'file':
      if (item.folder) {
        return `Folder ${oneLine(item.path)} on terminal ${oneLine(item.terminal)}`
      }
      return `File ${oneLine(item.path)}${item.lines ? `, ${rangeText(item.lines)}` : ''} on terminal ${oneLine(item.terminal)}${item.on ? ` (${oneLine(item.on)})` : ''}`
    case 'commit':
      return `Commit ${oneLine(item.sha)}${item.subject ? ` "${oneLine(item.subject)}"` : ''}${item.repository ? ` in ${oneLine(item.repository)}` : ''} on terminal ${oneLine(item.terminal)}`
    case 'app': {
      const [singular] = item.noun ?? ['item']
      return `${capitalised(oneLine(singular))} ${oneLine(item.name)}${item.lines ? `, ${rangeText(item.lines)}` : ''} in App ${oneLine(item.app)}`
    }
  }
}

/** Under an item the host cannot write a call for. */
const NO_CALL = '(no Read call: not a commit id)'

/** A commit id or a prefix of one, the only shell argument written unquoted. */
const COMMIT_ID = /^[0-9a-f]{4,64}$/i

/** The item's `Read:` line, or null when its fields cannot make a safe call. */
function callOf(item: Exclude<SelectionItem, { kind: 'node' }>): string | null {
  switch (item.kind) {
    case 'file':
      if (item.folder) {
        return read('remote_exec', {
          target: item.terminal,
          command: `ls -la -- ${shellQuoted(item.path)}`,
          description: 'List the selected folder',
        })
      }
      return read('remote_read', {
        target: item.terminal,
        path: item.path,
        ...(item.lines ? { offset: item.lines.from, limit: item.lines.to - item.lines.from + 1 } : {}),
      })
    case 'commit': {
      if (!COMMIT_ID.test(item.sha)) {
        return null
      }
      const git = item.repository ? `git -C ${shellQuoted(item.repository)}` : 'git'
      const show = item.path ? `show ${item.sha} -- ${shellQuoted(item.path)}` : `show --stat ${item.sha}`
      return read('remote_exec', {
        target: item.terminal,
        command: `${git} ${show}`,
        description: 'Show the selected commit',
      })
    }
    case 'app':
      return read('app_call', { app: item.app, action: item.action, params: item.params })
  }
}

/**
 * The highlighted text under its line, fenced with one backtick more than the
 * longest run inside it, and headed with its line range when it has one. Every
 * text item draws on one budget for the whole selection; once it is spent, the
 * rest is cut and the note says how much, and the item's `Read:` call above
 * gives all of it.
 */
function quoted(lines: LineRange | undefined, text: string, budget: { left: number }): string[] {
  const kept = text.slice(0, Math.max(0, budget.left))
  budget.left -= kept.length
  const longestRun = Math.max(0, ...[...kept.matchAll(/`+/g)].map((run) => run[0].length))
  const fence = '`'.repeat(Math.max(3, longestRun + 1))
  const out = [lines ? `Quoted (lines ${lines.from}-${lines.to}):` : 'Quoted:', fence, kept, fence]
  if (kept.length < text.length) {
    out.push(`(cut at ${count(kept.length)} of ${count(text.length)} characters; the Read call gives all of it)`)
  }
  return out
}

function read(tool: string, args: unknown): string {
  return `Read: ${tool} ${JSON.stringify(args)}`
}

function rangeText(lines: LineRange): string {
  return lines.from === lines.to ? `line ${lines.from}` : `lines ${lines.from}-${lines.to}`
}

/** A path in single quotes for a POSIX shell, with any `'` inside it closed, escaped and reopened. */
function shellQuoted(value: string): string {
  return `'${value.replaceAll("'", `'\\''`)}'`
}

function baseName(path: string): string {
  const trimmed = path.replace(/\/+$/, '')
  return trimmed.slice(trimmed.lastIndexOf('/') + 1) || trimmed || path
}

/** `text` on one line: every line break, with the spaces around it, becomes one space. */
function oneLine(text: string): string {
  return String(text).replace(/\s*[\n\r\v\f\u0085\u2028\u2029]\s*/g, ' ')
}

function cut(text: string, max: number): string {
  return text.length > max ? `${text.slice(0, max - 1)}…` : text
}

function capitalised(word: string): string {
  return word.charAt(0).toUpperCase() + word.slice(1)
}

function count(n: number): string {
  return n.toLocaleString('en-US')
}

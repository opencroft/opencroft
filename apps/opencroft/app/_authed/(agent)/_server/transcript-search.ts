// Full-text search over recorded transcripts (TranscriptMessage).
//
// Session-level and knows nothing of who may read what: the caller passes the
// session keys it has already established the reader is entitled to, and
// nothing outside them can match.

import { db, transcriptMessage } from '@opencroft/db'
import { boundedSelect } from '@opencroft/db/bounded-select'
import { and, desc, eq, inArray, sql } from 'drizzle-orm'

/** A piece of a snippet; `match` marks the words the query found. */
export interface SnippetPart {
  text: string
  match: boolean
}

export interface TranscriptHit {
  sessionKey: string
  /** The message's first event: its identity within the session. */
  position: number
  role: 'user' | 'agent'
  /** The position of the turn's question: where to open the transcript. */
  turn: number
  snippet: SnippetPart[]
  createdAt: Date
}

export interface TranscriptSearchResult {
  hits: TranscriptHit[]
  /** More rows matched than `limit`; the newest `limit` are returned. */
  truncated: boolean
}

// Delimiters ts_headline wraps each matched word in. Private-use code points,
// so recorded text cannot contain them by accident; stripped from the text
// before highlighting so it cannot contain them on purpose either.
const START = ''
const STOP = ''

/**
 * The newest messages in `sessionKeys` whose text holds every word of `query`,
 * each word matched as a prefix -- so a query typed so far ("deplo") already
 * finds what it is on its way to ("deploy").
 *
 * The query is split into words by the same parser the index was built with
 * (`plainto_tsquery`), never by a pattern of this module's own, so a word the
 * index holds whole (a host name, a version number, a path) is a word here too.
 * An empty answer for a query with no words in it, without touching the index.
 */
export async function searchTranscripts(
  sessionKeys: readonly string[],
  query: string,
  limit: number,
): Promise<TranscriptSearchResult> {
  if (sessionKeys.length === 0 || query.trim() === '') {
    return { hits: [], truncated: false }
  }
  // `'word'` -> `'word':*` on the parser's own rendering of the query: its
  // lexemes come back quoted with any quote inside doubled, so the closing
  // quote of each is the one followed by a space or the end.
  const tsquery = sql`to_tsquery('simple', regexp_replace(plainto_tsquery('simple', ${query})::text, '''(?=\\s|$)', ''':*', 'g'))`
  const entry = transcriptMessage
  // One hit per message however many of its segments match -- the earliest of
  // them.
  const matched = db
    .selectDistinctOn([entry.sessionKey, entry.position], {
      sessionKey: entry.sessionKey,
      position: entry.position,
      segment: entry.segment,
      role: entry.role,
      turn: entry.turn,
      createdAt: entry.createdAt,
    })
    .from(entry)
    .where(and(inArray(entry.sessionKey, [...sessionKeys]), sql`${entry.document} @@ ${tsquery}`))
    .orderBy(entry.sessionKey, entry.position, entry.segment)
    .as('matched')
  // Limited first, highlighted after: ts_headline re-parses the whole text of
  // a row, so it runs only for the rows actually returned.
  const newest = db
    .select()
    .from(matched)
    .orderBy(desc(matched.createdAt), desc(matched.position))
    .limit(limit + 1)
    .as('newest')
  const options = `StartSel=${START}, StopSel=${STOP}, MaxWords=24, MinWords=10, MaxFragments=2, FragmentDelimiter=" … "`
  const rows = await db
    .select({
      sessionKey: newest.sessionKey,
      position: newest.position,
      role: newest.role,
      turn: newest.turn,
      createdAt: newest.createdAt,
      headline: sql<string>`ts_headline('simple', translate(${entry.text}, ${START + STOP}, ''), ${tsquery}, ${options})`,
    })
    .from(newest)
    .innerJoin(
      entry,
      and(
        eq(entry.sessionKey, newest.sessionKey),
        eq(entry.position, newest.position),
        eq(entry.segment, newest.segment),
      ),
    )
    .orderBy(desc(newest.createdAt), desc(newest.position))
  return {
    hits: rows.slice(0, limit).map(({ headline, ...hit }) => ({ ...hit, snippet: snippetParts(headline) })),
    truncated: rows.length > limit,
  }
}

/**
 * The indexed message that starts at `position` -- its role and whole text,
 * segments joined -- or null when none does. What a turn the event cap has
 * trimmed is still known by.
 */
export async function indexedMessageAt(
  sessionKey: string,
  position: number,
): Promise<{ role: 'user' | 'agent'; text: string } | null> {
  // One message's segments add up to its whole text, which is not bounded by
  // what a SELECT can return, so they are read in bounded batches.
  type Segment = Pick<typeof transcriptMessage.$inferSelect, 'role' | 'text'>
  const rows: Segment[] = []
  for await (const row of boundedSelect<Segment>(db, {
    from: transcriptMessage,
    fields: { role: transcriptMessage.role, text: transcriptMessage.text },
    key: [transcriptMessage.segment],
    where: and(eq(transcriptMessage.sessionKey, sessionKey), eq(transcriptMessage.position, position)),
  })) {
    rows.push(row)
  }
  const first = rows[0]
  return first ? { role: first.role, text: rows.map((row) => row.text).join('') } : null
}

/** A ts_headline result, split at its delimiters into plain and matched parts. */
export function snippetParts(headline: string): SnippetPart[] {
  const parts: SnippetPart[] = []
  for (const [index, piece] of headline.split(START).entries()) {
    const [matched, rest] = index === 0 ? [null, piece] : splitOnce(piece, STOP)
    if (matched) {
      parts.push({ text: matched, match: true })
    }
    if (rest) {
      parts.push({ text: rest, match: false })
    }
  }
  return parts
}

function splitOnce(text: string, separator: string): [string, string] {
  const at = text.indexOf(separator)
  return at === -1 ? [text, ''] : [text.slice(0, at), text.slice(at + separator.length)]
}

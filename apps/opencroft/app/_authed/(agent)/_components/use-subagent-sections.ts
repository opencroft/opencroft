// The sections of subagents that keep a log of their own: each one's steps,
// loaded only once the reader expands it, then kept current by the stream.
//
// A collapsed section draws its header alone, which the session's own log
// carries (name, task, state and the step count). Expanding it fetches the
// newest steps of the subagent's log; "load older" inside it fetches the page
// above. From the moment a section is asked for, the steps the stream carries
// for it are applied too, and before that they are dropped: the fetch reads
// the log as it then stands. Every step frame carries its entry whole (see
// subagent-frames.ts), so applying one is setting the entry at its position,
// and a frame and a fetched window agree whatever order they arrive in.

import type { RecordsWindow } from 'agent-client/pagination'
import { useCallback, useRef, useState } from 'react'

import type { AuthoredChatEvent } from '@/app/_authed/(agent)/_lib/acp-stream'
import type { ChatMessage, ChatPart } from '@/app/_authed/(agent)/_lib/messages'
import type { SubagentStep } from '@/app/_authed/(agent)/_lib/subagent-frames'

/** One section's loaded steps, by position in the subagent's log. */
export interface SubagentSection {
  entries: ReadonlyMap<number, AuthoredChatEvent>
  // The first position the loaded window reaches, null until one has loaded.
  startIndex: number | null
  hasMore: boolean
  loading: boolean
}

const ASKED: SubagentSection = { entries: new Map(), startIndex: null, hasMore: false, loading: true }

/** A section with one stream frame's entry set at its position. */
export function withStep(section: SubagentSection, step: SubagentStep): SubagentSection {
  const entries = new Map(section.entries)
  entries.set(step.position, step.event)
  return { ...section, entries }
}

/**
 * A section with a fetched window added. An entry a frame has already set is
 * kept: a frame is the entry as of when it was emitted, and one that arrived
 * while the fetch was out can be newer than the window, never older than a
 * frame still to come.
 */
export function withWindow(
  section: SubagentSection,
  window: Pick<RecordsWindow, 'startIndex' | 'hasMore'> & { events: readonly AuthoredChatEvent[] },
): SubagentSection {
  const entries = new Map(section.entries)
  window.events.forEach((event, offset) => {
    const position = window.startIndex + offset
    if (!entries.has(position)) {
      entries.set(position, event)
    }
  })
  return {
    entries,
    startIndex: section.startIndex === null ? window.startIndex : Math.min(section.startIndex, window.startIndex),
    hasMore: window.hasMore,
    loading: false,
  }
}

/** A section's entries in log order. */
export function sectionEvents(section: SubagentSection): AuthoredChatEvent[] {
  return [...section.entries.entries()].sort(([a], [b]) => a - b).map(([, event]) => event)
}

export interface SectionActions {
  expand: (subagentSessionId: string) => void
  loadOlder: (subagentSessionId: string) => void
}

/**
 * `messages` with every section that keeps a log of its own given its loaded
 * steps and its controls, at any depth. `foldSteps` turns a section's entries
 * into the parts it draws; `terminal` there says the subagent has ended, so a
 * call it left open reads as the turn's end leaves one.
 */
export function withSections(
  messages: ChatMessage[],
  sections: ReadonlyMap<string, SubagentSection>,
  actions: SectionActions,
  foldSteps: (events: AuthoredChatEvent[], terminal: boolean) => ChatPart[],
): ChatMessage[] {
  const visit = (parts: ChatPart[]): ChatPart[] =>
    parts.map((part) => {
      if (part.type !== 'subagent') {
        return part
      }
      if (part.steps === undefined) {
        return { ...part, parts: visit(part.parts) }
      }
      const id = part.subagentSessionId
      const section = sections.get(id)
      const loaded = section && section.startIndex !== null
      return {
        ...part,
        parts: loaded ? visit(foldSteps(sectionEvents(section), part.state !== undefined)) : [],
        onExpand: () => actions.expand(id),
        ...(section?.loading ? { loading: true } : {}),
        ...(loaded && section.hasMore ? { onLoadOlder: () => actions.loadOlder(id) } : {}),
      }
    })
  return messages.map((message) => ({ ...message, parts: visit(message.parts) }))
}

/** How a section's window is fetched: the newest steps, or the page above `beforeIndex`. */
export type FetchSubagentPage = (
  subagentSessionId: string,
  beforeIndex?: number,
) => Promise<(Pick<RecordsWindow, 'startIndex' | 'hasMore'> & { events: AuthoredChatEvent[] }) | null>

/**
 * The sections of one session. `reset` forgets them all (a new session, a
 * reconnect: the stream's frames from before it are gone, so a section is
 * fetched again when asked). `applyStep` takes a frame the stream carried.
 */
export function useSubagentSections(fetchPage: FetchSubagentPage) {
  const [sections, setSections] = useState<ReadonlyMap<string, SubagentSection>>(new Map())
  // Read by the callbacks so each keeps one identity for the hook's life.
  const sectionsRef = useRef(sections)
  sectionsRef.current = sections
  const fetchRef = useRef(fetchPage)
  fetchRef.current = fetchPage
  // Bumped by reset, so a fetch that answers after it is dropped.
  const generationRef = useRef(0)

  const update = useCallback((id: string, change: (section: SubagentSection) => SubagentSection) => {
    setSections((current) => {
      const section = current.get(id)
      if (!section) {
        return current
      }
      const next = new Map(current)
      next.set(id, change(section))
      return next
    })
  }, [])

  const load = useCallback(
    (id: string, beforeIndex?: number) => {
      const generation = generationRef.current
      void fetchRef
        .current(id, beforeIndex)
        .catch((error: unknown) => {
          console.error('loading a subagent section failed', error)
          return null
        })
        .then((window) => {
          if (generation !== generationRef.current) {
            return
          }
          update(id, (section) => (window ? withWindow(section, window) : { ...section, loading: false }))
        })
    },
    [update],
  )

  const expand = useCallback(
    (id: string) => {
      const section = sectionsRef.current.get(id)
      if (section && (section.loading || section.startIndex !== null)) {
        return
      }
      // A section whose fetch failed is fetched again; the frames it has
      // taken since are kept, as they are over any window.
      setSections((current) => {
        const failed = current.get(id)
        return new Map(current).set(id, failed ? { ...failed, loading: true } : ASKED)
      })
      load(id)
    },
    [load],
  )

  const loadOlder = useCallback(
    (id: string) => {
      const section = sectionsRef.current.get(id)
      if (!section || section.loading || section.startIndex === null || !section.hasMore) {
        return
      }
      update(id, (current) => ({ ...current, loading: true }))
      load(id, section.startIndex)
    },
    [load, update],
  )

  const applyStep = useCallback(
    (step: SubagentStep) => {
      update(step.subagentSessionId, (section) => withStep(section, step))
    },
    [update],
  )

  // A section already asked for is fetched again, from its newest steps: its
  // block may be open, and nothing else would ask for it again.
  const refetch = useCallback(() => {
    generationRef.current += 1
    const asked = [...sectionsRef.current.keys()]
    setSections(new Map(asked.map((id) => [id, ASKED])))
    for (const id of asked) {
      load(id)
    }
  }, [load])

  const reset = useCallback(() => {
    generationRef.current += 1
    setSections(new Map())
  }, [])

  return { sections, expand, loadOlder, applyStep, refetch, reset }
}

// A live graph as one canvas tab holds it: the tab's copy of the graph's Yjs
// document, kept in sync with the collaboration server, and the tab's own
// undo history over it. Knows nothing of React; use-live-graph.ts binds it to
// the canvas.

import { HocuspocusProvider } from '@hocuspocus/provider'
import * as Y from 'yjs'

import type { LiveGraphSession } from '@/app/_authed/(space)/_lib/graph-collab-protocol'
import { applyGraphToDoc, readGraphFromDoc } from '@/app/_authed/(space)/_lib/graph-doc'
import { GraphUndo, type GraphUndoResult } from '@/app/_authed/(space)/_lib/graph-undo'
import type { GraphData } from '@/app/_authed/(space)/_server/types'
import { collabSocketUrl, STALE_LINEAGE_REASON } from '@/lib/collab-protocol'

export interface LiveGraphOptions {
  session: LiveGraphSession
  /** The graph the tab shows already, fetched as plain JSON before connecting. */
  initial: GraphData
  /** Called with the graph before and after every change this tab did not write -- including its own undo and redo. */
  onRemoteChange: (before: GraphData, after: GraphData) => void
  /** The server now holds another lineage of this document; the tab must open a fresh copy. */
  onStale: () => void
  /** Called when this tab becomes or stops being the graph's layout writer (see `isLayoutWriter`). */
  onLayoutWriterChange?: (writer: boolean) => void
  /** Defaults to the collaboration socket on the page's own host. */
  url?: string
}

/** An undo or redo, with the graph before it and after it. */
export interface LiveStepResult extends GraphUndoResult {
  before: GraphData
  after: GraphData
}

export interface WriteOptions {
  /** Joins the write to the step before when that step carried the same key (see GraphUndo.beginStep). */
  mergeKey?: string
  /** The write is no step of the tab's undo history: a change the canvas makes by itself. */
  untracked?: boolean
}

export class LiveGraph {
  private readonly doc = new Y.Doc()
  // The origin of this tab's own writes, which its undo history tracks.
  private readonly origin = {}
  // The origin of this tab's own writes that are no step of its undo history.
  private readonly untrackedOrigin = {}
  private readonly history: GraphUndo
  private readonly provider: HocuspocusProvider
  private shown: GraphData
  private synced = false
  private pending: { next: GraphData; base: GraphData; mergeKey?: string; untracked: boolean } | null = null
  private layoutWriter = false

  constructor({ session, initial, onRemoteChange, onStale, onLayoutWriterChange, url }: LiveGraphOptions) {
    this.shown = initial
    this.history = new GraphUndo(this.doc, this.origin)
    this.doc.on('update', (_update: Uint8Array, origin: unknown) => {
      const before = this.shown
      this.shown = readGraphFromDoc(this.doc)
      if (origin !== this.origin && origin !== this.untrackedOrigin) {
        onRemoteChange(before, this.shown)
      }
    })
    this.provider = new HocuspocusProvider({
      url: url ?? collabSocketUrl(),
      name: session.docName,
      document: this.doc,
      token: session.lineage,
      onAuthenticationFailed: ({ reason }) => {
        if (reason === STALE_LINEAGE_REASON) {
          onStale()
        }
      },
      onSynced: () => {
        this.synced = true
        if (this.pending) {
          const { next, base, mergeKey, untracked } = this.pending
          this.pending = null
          const before = this.shown
          this.write(next, base, { mergeKey, untracked })
          // The tab's own write is not reported as a remote change, but the
          // tab may have merged the synced state over it meanwhile: it is
          // shown the document as it now stands.
          onRemoteChange(before, this.shown)
        }
      },
    })
    // Presence for other viewers of the graph; who the viewer is comes from
    // the server's view of the connection, not from anything claimed here.
    this.provider.setAwarenessField('viewing', true)
    this.provider.awareness?.on('change', () => {
      const writer = this.isLayoutWriter()
      if (writer !== this.layoutWriter) {
        this.layoutWriter = writer
        onLayoutWriterChange?.(writer)
      }
    })
  }

  /**
   * Whether this tab stands to be the graph's layout writer: one whose page
   * the person can see. A hidden page's browser does not lay out, so its
   * tab would not see a node change size.
   */
  setLayoutCandidate(candidate: boolean): void {
    this.provider.setAwarenessField('layoutCandidate', candidate)
  }

  /**
   * Whether this tab is the one that writes the layouts every viewer computes
   * alike (Section autolayout): of the tabs standing as candidates, the one
   * with the lowest client id. Each tab elects from the same presence, so
   * they agree once it has reached them all.
   */
  isLayoutWriter(): boolean {
    const states = this.provider.awareness?.getStates()
    if (!states) {
      return false
    }
    const candidates = [...states].filter(([, state]) => state.layoutCandidate === true).map(([id]) => id)
    return candidates.length > 0 && Math.min(...candidates) === this.doc.clientID
  }

  /**
   * Writes what the tab changed: the difference between `base` -- the graph
   * the tab's state was derived from -- and `next`, its state now. Changes in
   * the document the tab has not taken in yet are left alone, never reverted.
   * The write is one step of this tab's undo history, or joins the step
   * before when it carries that step's `mergeKey` (see GraphUndo.beginStep).
   * An `untracked` write is no step at all: undo neither reverts it nor
   * overwrites it.
   *
   * Before the first sync the latest write waits, with its base, and is
   * written once the copy is in step: an edit made while connecting is
   * neither lost nor written over what the server holds. It is untracked
   * only if every write that waited was.
   */
  write(next: GraphData, base: GraphData, { mergeKey, untracked = false }: WriteOptions = {}): void {
    if (!this.synced) {
      const waited = this.pending
      this.pending = { next, base: waited?.base ?? base, mergeKey, untracked: untracked && (waited?.untracked ?? true) }
      return
    }
    if (untracked) {
      applyGraphToDoc(this.doc, next, { base, origin: this.untrackedOrigin })
      return
    }
    this.history.beginStep(mergeKey)
    applyGraphToDoc(this.doc, next, { base, origin: this.origin })
  }

  undo(): LiveStepResult | null {
    return this.step(() => this.history.undo())
  }

  redo(): LiveStepResult | null {
    return this.step(() => this.history.redo())
  }

  // The step runs on the document at once, so the graph it leaves is read
  // straight after it.
  private step(run: () => GraphUndoResult | null): LiveStepResult | null {
    const before = this.shown
    const result = run()
    return result && { ...result, before, after: this.shown }
  }

  destroy(): void {
    this.provider.destroy()
    this.history.destroy()
    this.doc.destroy()
  }
}

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
  /** Defaults to the collaboration socket on the page's own host. */
  url?: string
}

export class LiveGraph {
  private readonly doc = new Y.Doc()
  // The origin of this tab's own writes, which its undo history tracks.
  private readonly origin = {}
  private readonly history: GraphUndo
  private readonly provider: HocuspocusProvider
  private shown: GraphData
  private synced = false
  private pending: { next: GraphData; base: GraphData; mergeKey?: string } | null = null

  constructor({ session, initial, onRemoteChange, onStale, url }: LiveGraphOptions) {
    this.shown = initial
    this.history = new GraphUndo(this.doc, this.origin)
    this.doc.on('update', (_update: Uint8Array, origin: unknown) => {
      const before = this.shown
      this.shown = readGraphFromDoc(this.doc)
      if (origin !== this.origin) {
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
          const { next, base, mergeKey } = this.pending
          this.pending = null
          const before = this.shown
          this.write(next, base, mergeKey)
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
  }

  /**
   * Writes what the tab changed: the difference between `base` -- the graph
   * the tab's state was derived from -- and `next`, its state now. Changes in
   * the document the tab has not taken in yet are left alone, never reverted.
   * The write is one step of this tab's undo history, or joins the step
   * before when it carries that step's `mergeKey` (see GraphUndo.beginStep).
   *
   * Before the first sync the latest write waits, with its base, and is
   * written once the copy is in step: an edit made while connecting is
   * neither lost nor written over what the server holds.
   */
  write(next: GraphData, base: GraphData, mergeKey?: string): void {
    if (!this.synced) {
      this.pending = { next, base: this.pending?.base ?? base, mergeKey }
      return
    }
    this.history.beginStep(mergeKey)
    applyGraphToDoc(this.doc, next, { base, origin: this.origin })
  }

  undo(): GraphUndoResult | null {
    return this.history.undo()
  }

  redo(): GraphUndoResult | null {
    return this.history.redo()
  }

  destroy(): void {
    this.provider.destroy()
    this.history.destroy()
    this.doc.destroy()
  }
}

// Per-writer undo over a graph doc (see graph-doc.ts).
//
// Built on Y.UndoManager, which already gives the rules that matter when
// others edit the same graph: it only tracks transactions made under the
// writer's own origin, and by default never overwrites a remote change -- an
// undo of a field someone has since set leaves their value. Two of its
// behaviours do not fit a graph and are changed here:
//
// - Undo stops at one step (`stepLatest`): a step that others have wholly
//   overwritten is dropped and reported as not applied, rather than skipped
//   for an older one; the next undo reaches the older one.
// - Undo never removes a node that someone else has since connected an edge to
//   or placed a child in. Y.UndoManager would delete it and leave their edge
//   pointing at nothing. Such a node is kept, with every field it was created
//   with, and reported.

import * as Y from 'yjs'

import { graphEdges, graphNodes } from '@/app/_authed/(space)/_lib/graph-doc'
import { MERGE_WINDOW_MS, stepLatest } from '@/lib/undo-latest-step'

export interface GraphUndoResult {
  /** False when the step had nothing left to change: others replaced all of it. */
  applied: boolean
  /** Nodes the step would have removed but kept, because others now depend on them. */
  keptNodeIds: string[]
}

type StackItem = Y.UndoManager['undoStack'][number]

export class GraphUndo {
  private readonly manager: Y.UndoManager
  private readonly nodes: Y.Map<Y.Map<unknown>>
  private readonly edges: Y.Map<Y.Map<unknown>>
  private keep = new Set<string>()
  private kept = new Set<string>()
  private lastMergeKey: string | undefined

  /** Tracks transactions made under `origin` -- one transaction is one step. */
  constructor(doc: Y.Doc, origin: object) {
    this.nodes = graphNodes(doc)
    this.edges = graphEdges(doc)
    this.manager = new Y.UndoManager([this.nodes, this.edges], {
      trackedOrigins: new Set([origin]),
      captureTimeout: 0,
      deleteFilter: (item) => {
        const id = this.owningNode(item)
        if (id !== null && this.keep.has(id)) {
          this.kept.add(id)
          return false
        }
        return true
      },
    })
  }

  /**
   * Call before each write made under this writer's origin. A write carrying
   * the same `mergeKey` as the write before it, within MERGE_WINDOW_MS of it,
   * joins that write's step -- typing into one field is one step. Any other
   * write starts a step of its own.
   */
  beginStep(mergeKey?: string): void {
    if (mergeKey !== undefined && mergeKey === this.lastMergeKey) {
      this.manager.captureTimeout = MERGE_WINDOW_MS
    } else {
      this.manager.stopCapturing()
      this.manager.captureTimeout = 0
    }
    this.lastMergeKey = mergeKey
  }

  get canUndo(): boolean {
    return this.manager.undoStack.length > 0
  }

  get canRedo(): boolean {
    return this.manager.redoStack.length > 0
  }

  /** Reverts this writer's latest step; null when there is none. */
  undo(): GraphUndoResult | null {
    return this.step(this.manager.undoStack, () => this.manager.undo())
  }

  /** Re-applies the latest undone step; null when there is none. */
  redo(): GraphUndoResult | null {
    return this.step(this.manager.redoStack, () => this.manager.redo())
  }

  destroy(): void {
    this.manager.destroy()
  }

  private step(stack: StackItem[], run: () => StackItem | null): GraphUndoResult | null {
    const top = stack.at(-1)
    if (!top) {
      return null
    }
    // A write after an undo or redo never joins the step before it.
    this.lastMergeKey = undefined
    this.keep = this.createdAndSinceReferenced(top)
    try {
      const applied = stepLatest(stack, run)
      return { applied, keptNodeIds: [...this.kept] }
    } finally {
      this.keep = new Set()
      this.kept = new Set()
    }
  }

  // Nodes this step created that an edge end or a child's parent, set outside
  // the step, now points at. A reference the step set itself -- an existing
  // edge re-pointed at its new node, an existing node moved into it -- is
  // reverted by the same undo, so it keeps nothing.
  private createdAndSinceReferenced(step: StackItem): Set<string> {
    const stepItems = this.itemsOf(step)
    const madeHere = (item: Y.Item | null | undefined) => item != null && stepItems.has(item)
    const created = new Set<string>()
    for (const [id, node] of this.nodes.entries()) {
      if (madeHere(node._item)) {
        created.add(id)
      }
    }
    const referenced = new Set<string>()
    const pointsAtCreated = (element: Y.Map<unknown>, key: string) => {
      const value = element.get(key)
      if (typeof value === 'string' && created.has(value) && !madeHere(element._map.get(key))) {
        referenced.add(value)
      }
    }
    for (const edge of this.edges.values()) {
      pointsAtCreated(edge, 'source')
      pointsAtCreated(edge, 'target')
    }
    for (const node of this.nodes.values()) {
      pointsAtCreated(node, 'parentId')
    }
    return referenced
  }

  // The items `step` inserted, each as it stands now. Y.UndoManager restores
  // a value or element that a later step overwrote or deleted as a new item
  // (inside a new map, for a deleted element), linked from the old one through
  // `redone`; such a copy stands for what the step wrote.
  private itemsOf(step: StackItem): Set<Y.Item> {
    const items = new Set<Y.Item>()
    const store = this.nodes.doc?.store
    if (!store) {
      return items
    }
    for (const [client, ranges] of step.insertions.clients) {
      for (const { clock, len } of ranges) {
        for (let at = clock; at < clock + len; ) {
          const struct = Y.getItem(store, Y.createID(client, at))
          at = struct.id.clock + struct.length
          if (struct instanceof Y.Item) {
            let current = struct
            while (current.redone) {
              current = Y.getItem(store, current.redone) as Y.Item
            }
            items.add(current)
          }
        }
      }
    }
    return items
  }

  // The id of the node an item belongs to -- the node entry itself, or any
  // field nested under it -- or null for an item outside the nodes map.
  private owningNode(item: Y.Item): string | null {
    let current: Y.Item | null = item
    while (current) {
      const parent = current.parent as Y.AbstractType<unknown> | null
      if (parent === this.nodes) {
        return current.parentSub
      }
      current = parent?._item ?? null
    }
    return null
  }
}

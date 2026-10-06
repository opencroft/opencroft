'use client'

import type { Edge, Node } from '@xyflow/react'
import { type KeyboardEvent as ReactKeyboardEvent, useCallback, useState } from 'react'
import { toast } from 'sonner'

import { hasTextSelectionIn, isCanvasKeyPress } from '@/app/_authed/(dashboard)/_canvas/canvas-key-scope'
import { assignPasteIds } from '@/app/_authed/(dashboard)/_canvas/paste-ids'
import { newGraphId } from '@/lib/graph-id'

const FORMAT = 'opencroft/nodes'
const PASTE_OFFSET = 20

interface Payload {
  format: typeof FORMAT
  nodes: Node[]
  edges: Edge[]
}

interface Options {
  /**
   * Which of these ids any OTHER graph already uses. The graph being edited is
   * the caller's to leave out: the canvas holds it newer than the server does.
   */
  findTakenIds: (ids: string[]) => Promise<string[]>
  nodes: Node[]
  edges: Edge[]
  setNodes: (updater: (nodes: Node[]) => Node[]) => void
  setEdges: (updater: (edges: Edge[]) => Edge[]) => void
  onChange: (nodes: Node[], edges: Edge[]) => void
}

function selectedSet(nodes: Node[]): Node[] {
  return nodes.filter((n) => n.selected && n.type !== 'comment')
}

function edgesBetween(edges: Edge[], ids: Set<string>): Edge[] {
  return edges.filter((e) => ids.has(e.source) && ids.has(e.target))
}

// navigator.clipboard access is markedly less reliable on mobile browsers
// than desktop -- readText() in particular can reject outright depending on
// permission state, which is exactly the class of failure suspected here
// ("not sure copying nodes even works properly on touch"). Both directions
// already had no error handling at all, which turns a permission rejection
// into a silent no-op indistinguishable from "nothing was selected" -- the
// same failure class as the touch-tap bugs elsewhere in this area. Surface
// it instead.
async function writePayload(nodes: Node[], edges: Edge[]): Promise<boolean> {
  const payload: Payload = { format: FORMAT, nodes, edges }
  try {
    await navigator.clipboard.writeText(JSON.stringify(payload))
    return true
  } catch (err) {
    console.error('[use-clipboard] copy failed:', err)
    toast.error('Copy failed', { description: err instanceof Error ? err.message : String(err) })
    return false
  }
}

async function readPayload(): Promise<Payload | null> {
  let text: string
  try {
    text = await navigator.clipboard.readText()
  } catch (err) {
    console.error('[use-clipboard] paste failed:', err)
    toast.error('Paste failed', { description: err instanceof Error ? err.message : String(err) })
    return null
  }
  if (!text) {
    return null
  }
  const data = JSON.parse(text) as Partial<Payload>
  if (data.format !== FORMAT || !Array.isArray(data.nodes) || !Array.isArray(data.edges)) {
    return null
  }
  return { format: FORMAT, nodes: data.nodes, edges: data.edges }
}

// A failed lookup treats every id as taken: fresh ids can never collide,
// kept ones only can.
async function takenElsewhere(ids: string[], findTakenIds: Options['findTakenIds']): Promise<Set<string>> {
  try {
    return new Set(await findTakenIds(ids))
  } catch (err) {
    console.error('[use-clipboard] id check failed, pasting with fresh ids:', err)
    return new Set(ids)
  }
}

// `target`, when given, is a flow-space point (e.g. where a context menu was
// invoked) that the pasted group's own top-left corner lands on, keeping the
// copied nodes' positions relative to each other. Without one (the keyboard
// shortcut, which has no invocation point to speak of) the group is offset
// by a small fixed amount from where it was copied, as before.
//
// Ids are kept unless taken (see assignPasteIds): a cut-and-paste moves the
// very same nodes, so anything referring to them still does.
function remap(
  payload: Payload,
  taken: ReadonlySet<string>,
  target?: { x: number; y: number },
): { nodes: Node[]; edges: Edge[] } {
  const offset = target
    ? {
        x: target.x - Math.min(...payload.nodes.map((n) => n.position.x)),
        y: target.y - Math.min(...payload.nodes.map((n) => n.position.y)),
      }
    : { x: PASTE_OFFSET, y: PASTE_OFFSET }
  const assigned = assignPasteIds(
    payload.nodes as Array<Node & { data: Record<string, unknown> }>,
    payload.edges,
    taken,
    newGraphId,
  )
  return {
    nodes: assigned.nodes.map((n) => ({
      ...n,
      position: { x: n.position.x + offset.x, y: n.position.y + offset.y },
      selected: true,
    })),
    edges: assigned.edges.map((e) => ({ ...e, selected: false })),
  }
}

export interface ClipboardControls {
  copy: () => Promise<void>
  paste: (target?: { x: number; y: number }) => Promise<void>
  /** True once a copy/cut has written something pasteable in this session. */
  hasCopiedNodes: boolean
  /**
   * Ctrl/Cmd+C, X and V for the canvas element's `onKeyDown`. Acts only on
   * presses `isCanvasKeyPress` gives the canvas; every other press keeps the
   * browser's own copy, cut and paste.
   */
  onKeyDown: (event: ReactKeyboardEvent<Element>) => void
}

type ClipboardAction = 'copy' | 'cut' | 'paste'

// Matched on `event.code` (the physical key), not `event.key` (the character
// it produces): on a non-QWERTY layout the keys are in the same place but type
// a different character, so a `key`-based match would never fire there.
const SHORTCUTS: Readonly<Record<string, ClipboardAction>> = { KeyC: 'copy', KeyX: 'cut', KeyV: 'paste' }

function shortcutAction(event: KeyboardEvent, canvas: Element): ClipboardAction | null {
  if (!(event.ctrlKey || event.metaKey) || event.shiftKey || event.altKey) {
    return null
  }
  const action = Object.hasOwn(SHORTCUTS, event.code) ? SHORTCUTS[event.code] : undefined
  if (!action || !isCanvasKeyPress(event, canvas)) {
    return null
  }
  // Text selected inside a node (an error message, an output) is copied as
  // text, the way it would be anywhere else on the page.
  if (action !== 'paste' && hasTextSelectionIn(canvas)) {
    return null
  }
  return action
}

export function useClipboard({ findTakenIds, nodes, edges, setNodes, setEdges, onChange }: Options): ClipboardControls {
  // Tracked directly off a successful copy/cut rather than re-reading the
  // system clipboard on every render: navigator.clipboard has no change
  // event, and re-probing readText() to decide whether to enable a menu
  // item would hit the same permission unreliability this file otherwise
  // avoids for the actual paste. The tradeoff is real and narrow: content
  // copied in a previous session (before a reload) won't show as pasteable
  // until copied again here.
  const [hasCopiedNodes, setHasCopiedNodes] = useState(false)

  const copy = useCallback(async () => {
    const picked = selectedSet(nodes)
    if (picked.length === 0) {
      return
    }
    const ids = new Set(picked.map((n) => n.id))
    const pickedEdges = edgesBetween(edges, ids)
    if (await writePayload(picked, pickedEdges)) {
      setHasCopiedNodes(true)
    }
  }, [nodes, edges])

  const cut = useCallback(async () => {
    const picked = selectedSet(nodes)
    if (picked.length === 0) {
      return
    }
    const ids = new Set(picked.map((n) => n.id))
    const pickedEdges = edgesBetween(edges, ids)
    if (!(await writePayload(picked, pickedEdges))) {
      return
    }
    setHasCopiedNodes(true)
    const nextNodes = nodes.filter((n) => !ids.has(n.id))
    const nextEdges = edges.filter((e) => !ids.has(e.source) && !ids.has(e.target))
    setNodes(() => nextNodes)
    setEdges(() => nextEdges)
    onChange(nextNodes, nextEdges)
  }, [nodes, edges, setNodes, setEdges, onChange])

  const paste = useCallback(
    async (target?: { x: number; y: number }) => {
      const payload = await readPayload()
      if (!payload) {
        return
      }
      const ids = [...payload.nodes.map((n) => n.id), ...payload.edges.map((e) => e.id)]
      const taken = await takenElsewhere(ids, findTakenIds)
      for (const item of [...nodes, ...edges]) {
        taken.add(item.id)
      }
      const { nodes: pastedNodes, edges: pastedEdges } = remap(payload, taken, target)
      if (pastedNodes.length === 0) {
        return
      }
      const nextNodes = [...nodes.map((n) => (n.selected ? { ...n, selected: false } : n)), ...pastedNodes]
      const nextEdges = [...edges, ...pastedEdges]
      setNodes(() => nextNodes)
      setEdges(() => nextEdges)
      onChange(nextNodes, nextEdges)
    },
    [findTakenIds, nodes, edges, setNodes, setEdges, onChange],
  )

  const onKeyDown = useCallback(
    (event: ReactKeyboardEvent<Element>) => {
      const action = shortcutAction(event.nativeEvent, event.currentTarget)
      if (!action) {
        return
      }
      event.preventDefault()
      if (action === 'copy') {
        copy()
      } else if (action === 'cut') {
        cut()
      } else {
        paste()
      }
    },
    [copy, cut, paste],
  )

  return { copy, paste, hasCopiedNodes, onKeyDown }
}

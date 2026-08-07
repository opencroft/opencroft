'use client'

import type { Edge, Node } from '@xyflow/react'
import { useCallback, useEffect, useState } from 'react'
import { toast } from 'sonner'

const FORMAT = 'opencroft/nodes'
const PASTE_OFFSET = 20

interface Payload {
  format: typeof FORMAT
  nodes: Node[]
  edges: Edge[]
}

interface Options {
  nodes: Node[]
  edges: Edge[]
  setNodes: (updater: (nodes: Node[]) => Node[]) => void
  setEdges: (updater: (edges: Edge[]) => Edge[]) => void
  onChange: (nodes: Node[], edges: Edge[]) => void
}

function newId(prefix: string): string {
  return `${prefix}_${Math.random().toString(36).slice(2, 10)}`
}

function isEditing(): boolean {
  const el = document.activeElement as HTMLElement | null
  if (!el) {
    return false
  }
  const tag = el.tagName
  if (tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT') {
    return true
  }
  return el.isContentEditable
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

// `target`, when given, is a flow-space point (e.g. where a context menu was
// invoked) that the pasted group's own top-left corner lands on, keeping the
// copied nodes' positions relative to each other. Without one (the keyboard
// shortcut, which has no invocation point to speak of) the group is offset
// by a small fixed amount from where it was copied, as before.
function remap(payload: Payload, target?: { x: number; y: number }): { nodes: Node[]; edges: Edge[] } {
  const offset = target
    ? {
        x: target.x - Math.min(...payload.nodes.map((n) => n.position.x)),
        y: target.y - Math.min(...payload.nodes.map((n) => n.position.y)),
      }
    : { x: PASTE_OFFSET, y: PASTE_OFFSET }
  const idMap = new Map<string, string>()
  const nodes = payload.nodes.map((n) => {
    const id = newId(n.type ?? 'node')
    idMap.set(n.id, id)
    return {
      ...n,
      id,
      position: { x: n.position.x + offset.x, y: n.position.y + offset.y },
      selected: true,
      ...(n.parentId ? { parentId: idMap.get(n.parentId) ?? n.parentId } : {}),
    }
  })
  const edges = payload.edges
    .filter((e) => idMap.has(e.source) && idMap.has(e.target))
    .map((e) => ({
      ...e,
      id: newId('edge'),
      source: idMap.get(e.source)!,
      target: idMap.get(e.target)!,
      selected: false,
    }))
  return { nodes, edges }
}

export interface ClipboardControls {
  copy: () => Promise<void>
  paste: (target?: { x: number; y: number }) => Promise<void>
  /** True once a copy/cut has written something pasteable in this session. */
  hasCopiedNodes: boolean
}

export function useClipboard({ nodes, edges, setNodes, setEdges, onChange }: Options): ClipboardControls {
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
      const { nodes: pastedNodes, edges: pastedEdges } = remap(payload, target)
      if (pastedNodes.length === 0) {
        return
      }
      const nextNodes = [...nodes.map((n) => (n.selected ? { ...n, selected: false } : n)), ...pastedNodes]
      const nextEdges = [...edges, ...pastedEdges]
      setNodes(() => nextNodes)
      setEdges(() => nextEdges)
      onChange(nextNodes, nextEdges)
    },
    [nodes, edges, setNodes, setEdges, onChange],
  )

  // Copy has no hotkey — it hijacked every Ctrl+C on the page (the isEditing()
  // guard below only recognizes focus on an input/textarea/select/contentEditable,
  // so copying selected text anywhere else, e.g. a log viewer, still got
  // overwritten with node JSON). Copy is now only reachable from the node
  // context menu. Cut/paste keep their hotkeys — not implicated in that bug.
  useEffect(() => {
    function handler(e: KeyboardEvent) {
      if (!(e.ctrlKey || e.metaKey)) {
        return
      }
      if (isEditing()) {
        return
      }
      const key = e.key.toLowerCase()
      if (key === 'x') {
        e.preventDefault()
        cut()
        return
      }
      if (key === 'v') {
        e.preventDefault()
        paste()
      }
    }
    window.addEventListener('keydown', handler)
    return () => window.removeEventListener('keydown', handler)
  }, [cut, paste])

  return { copy, paste, hasCopiedNodes }
}

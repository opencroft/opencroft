import { type RefObject, useLayoutEffect, useState } from 'react'

import type { MarkdownTableAlign } from './markdown-table'

interface Span {
  start: number
  size: number
}

/**
 * Where the rows and columns are, measured from the rendered table, so the
 * controls line up with cells of any width. Offsets are in the table's own
 * box; `x`/`y` place that box inside the frame's scrolled content.
 */
export interface Layout {
  x: number
  y: number
  columns: Span[]
  rows: Span[]
  aligns: (MarkdownTableAlign | null)[]
  width: number
  height: number
}

function readAlign(value: string): MarkdownTableAlign | null {
  return value === 'left' || value === 'center' || value === 'right' ? value : null
}

function measure(frame: HTMLElement, table: HTMLTableElement): Layout {
  const frameBox = frame.getBoundingClientRect()
  const tableBox = table.getBoundingClientRect()
  const cells = table.rows[0] ? [...table.rows[0].cells] : []
  return {
    x: tableBox.left - frameBox.left + frame.scrollLeft,
    y: tableBox.top - frameBox.top,
    columns: cells.map((cell) => {
      const box = cell.getBoundingClientRect()
      return { start: box.left - tableBox.left, size: box.width }
    }),
    rows: [...table.rows].map((row) => {
      const box = row.getBoundingClientRect()
      return { start: box.top - tableBox.top, size: box.height }
    }),
    aligns: cells.map((cell) => readAlign(cell.style.textAlign)),
    width: frameBox.width,
    height: frameBox.height,
  }
}

/** The lines between and around the spans: one more than there are spans. */
export function boundaries(spans: Span[]): number[] {
  const last = spans.at(-1)
  return last ? [...spans.map((span) => span.start), last.start + last.size] : []
}

/** The index of the line closest to `at`. */
export function nearest(lines: number[], at: number): number {
  let best = 0
  lines.forEach((line, index) => {
    if (Math.abs(line - at) < Math.abs(lines[best] - at)) {
      best = index
    }
  })
  return best
}

/** The layout of the table inside `frameRef` while `enabled`, followed through resizes and edits. */
export function useTableLayout(frameRef: RefObject<HTMLDivElement | null>, enabled: boolean): Layout | null {
  const [layout, setLayout] = useState<Layout | null>(null)
  useLayoutEffect(() => {
    const frame = frameRef.current
    const table = frame?.querySelector('table')
    if (!enabled || !frame || !table) {
      setLayout(null)
      return
    }
    const update = () => setLayout(measure(frame, table))
    update()
    const resize = new ResizeObserver(update)
    resize.observe(table)
    resize.observe(frame)
    // Typing into a cell can move every boundary after it without resizing
    // the table, when a column widens and a later one gives the space back.
    const mutations = new MutationObserver(update)
    mutations.observe(table, { subtree: true, childList: true, characterData: true, attributes: true })
    return () => {
      resize.disconnect()
      mutations.disconnect()
    }
  }, [frameRef, enabled])
  return layout
}

interface Box {
  left: number
  top: number
  right: number
  bottom: number
}

/**
 * Where a layer over the page draws the frame's controls: the element it goes
 * in, the frame's box, and the part of the screen the frame's scrolling
 * ancestors leave visible. Boxes are in the coordinates a `fixed` element in
 * `host` is placed by.
 */
export interface Placement {
  host: HTMLElement
  frame: Box
  visible: Box
}

/**
 * The element the layer goes in: the dialog the table is in, else the body.
 * Inside a dialog it has to be part of it -- a dialog takes a press anywhere
 * outside itself as a dismissal, and keeps focus out of the rest of the page.
 */
function layerHost(frame: HTMLElement): HTMLElement {
  return frame.closest<HTMLElement>('[role="dialog"], [role="alertdialog"]') ?? document.body
}

/**
 * Where the layer's `fixed` coordinates start on screen, read off the layer
 * where it stands: the viewport's corner, unless an ancestor -- a dialog that
 * centres itself with a transform -- makes itself the origin instead. Before
 * the layer is drawn, the viewport's corner.
 */
function fixedOrigin(layer: HTMLElement | null): { left: number; top: number } {
  if (!layer) {
    return { left: 0, top: 0 }
  }
  const box = layer.getBoundingClientRect()
  return {
    left: box.left - (Number.parseFloat(layer.style.left) || 0),
    top: box.top - (Number.parseFloat(layer.style.top) || 0),
  }
}

function shift(box: Box, by: { left: number; top: number }): Box {
  return { left: box.left - by.left, top: box.top - by.top, right: box.right - by.left, bottom: box.bottom - by.top }
}

/** The ancestors that can clip: the only ones whose scrolling can hide the frame. */
function clippingAncestors(frame: HTMLElement): HTMLElement[] {
  const found: HTMLElement[] = []
  for (let element = frame.parentElement; element; element = element.parentElement) {
    const style = getComputedStyle(element)
    if (style.overflowX !== 'visible' || style.overflowY !== 'visible') {
      found.push(element)
    }
  }
  return found
}

/**
 * An ancestor clips the controls only along an axis it actually scrolls. One
 * that merely could scroll -- an editor's text area that grows with its text,
 * set to scroll should it ever be capped -- has nothing out of view, so the
 * controls may hang past its edges. One that scrolls lets them hang
 * `overhang` past its edges, as far as the controls reach out of the frame:
 * a table resting at its edge keeps its controls whole, and one scrolled
 * further out takes them with it.
 *
 * A frame that is not drawn (inside a hidden panel) reports an empty box at
 * the viewport's corner, which puts every strip above or left of the screen.
 */
function place(
  frame: HTMLElement,
  clippers: HTMLElement[],
  overhang: number,
  host: HTMLElement,
  layer: HTMLElement | null,
): Placement {
  const box = frame.getBoundingClientRect()
  const root = document.documentElement
  const visible = { left: 0, top: 0, right: root.clientWidth, bottom: root.clientHeight }
  for (const element of clippers) {
    const own = element.getBoundingClientRect()
    const left = own.left + element.clientLeft
    const top = own.top + element.clientTop
    if (element.scrollWidth > element.clientWidth) {
      visible.left = Math.max(visible.left, left - overhang)
      visible.right = Math.min(visible.right, left + element.clientWidth + overhang)
    }
    if (element.scrollHeight > element.clientHeight) {
      visible.top = Math.max(visible.top, top - overhang)
      visible.bottom = Math.min(visible.bottom, top + element.clientHeight + overhang)
    }
  }
  const origin = fixedOrigin(layer)
  return { host, frame: shift(box, origin), visible: shift(visible, origin) }
}

function samePlacement(a: Placement | null, b: Placement): boolean {
  if (a === null || a.host !== b.host) {
    return false
  }
  const keys = ['left', 'top', 'right', 'bottom'] as const
  return keys.every((key) => a.frame[key] === b.frame[key] && a.visible[key] === b.visible[key])
}

/**
 * The frame's place on screen while `enabled`, followed every frame. Anything
 * can move it -- a scroll of any ancestor, text typed above it, a panel
 * opening beside it -- and no one event reports them all, so it is read on
 * each animation frame and a new value set only when it moved. `layerRef` is
 * the layer drawn from it, read for where its coordinates start; `overhang`
 * is how far its controls reach out of the frame, in px.
 */
export function useFramePlacement(
  frameRef: RefObject<HTMLDivElement | null>,
  layerRef: RefObject<HTMLDivElement | null>,
  enabled: boolean,
  overhang: number,
): Placement | null {
  const [placement, setPlacement] = useState<Placement | null>(null)
  useLayoutEffect(() => {
    const frame = frameRef.current
    if (!enabled || !frame) {
      setPlacement(null)
      return
    }
    const clippers = clippingAncestors(frame)
    const host = layerHost(frame)
    let current: Placement | null = null
    let request = 0
    const follow = () => {
      const next = place(frame, clippers, overhang, host, layerRef.current)
      if (!samePlacement(current, next)) {
        current = next
        setPlacement(next)
      }
      request = requestAnimationFrame(follow)
    }
    follow()
    return () => cancelAnimationFrame(request)
  }, [frameRef, layerRef, enabled, overhang])
  return placement
}

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

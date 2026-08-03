// The two probes that let a component tell whether a host capability is
// present without being taken down by its absence. Both are rendered for
// real, with no provider above them, because "returns null instead of
// throwing" is the entire contract and it only holds at render time.
//
// createElement rather than JSX: this workspace compiles JSX through vite, and
// the test runner would need its own transform configured to match.

import assert from 'node:assert/strict'
import test from 'node:test'

import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'

import { useCanvasNodes } from './canvas-nodes-context'
import { useOptionalOverlay, useOverlay } from './overlay-context'

function renderProbe(useProbe: () => unknown): unknown {
  let seen: unknown
  const Probe = () => {
    seen = useProbe()
    return null
  }
  renderToStaticMarkup(createElement(Probe))
  return seen
}

test('useCanvasNodes returns null with no canvas, rather than throwing', () => {
  assert.equal(renderProbe(useCanvasNodes), null)
})

test('useOptionalOverlay returns null with no overlay, rather than throwing', () => {
  assert.equal(
    renderProbe(() => useOptionalOverlay()),
    null,
  )
})

test('useOptionalOverlay discards published slots instead of failing on them', () => {
  // Publishing is what the approval-mode views do. With no overlay to publish
  // into, the write has to go nowhere quietly — not throw.
  assert.equal(
    renderProbe(() => useOptionalOverlay({ content: 'ignored' })),
    null,
  )
})

test('useOverlay still throws for callers that genuinely require the overlay', () => {
  // The strict hook keeps its contract: a component that cannot work without
  // the overlay should fail loudly rather than half-render. Only components
  // that render on both kinds of surface use the optional form.
  assert.throws(() => renderProbe(() => useOverlay()), /within an <OverlayProvider>/)
})

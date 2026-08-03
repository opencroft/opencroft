// Tool views must not reach for host context at render.
//
// A tool view is rendered by the chat surface, and the chat surface is mounted
// on more than one host: the canvas overlay, which has a ReactFlowProvider and
// an OverlayProvider above it, and standalone chat routes, which have neither.
// A hook that requires either one throws where it is missing, and React
// unmounts the whole route — so a single tool call made the page unopenable,
// permanently, because the transcript replays that message from stored history
// on every visit.
//
// This is a source check rather than a render test on purpose. Rendering the
// real views from here is not currently possible (kit components under
// packages/ui import through an `@/` alias that does not resolve from this
// workspace), and a check that reads the source catches the whole class —
// including a view added later — instead of only the cases someone remembered
// to render.

import assert from 'node:assert/strict'
import { readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import test from 'node:test'

// Hooks that throw when their provider is missing. The safe replacements
// report absence as a value: useCanvasNodes() and useOptionalOverlay().
const FORBIDDEN = ['useReactFlow', 'useOverlay']

const dir = import.meta.dirname
const sources = readdirSync(dir).filter((f) => (f.endsWith('.ts') || f.endsWith('.tsx')) && !f.endsWith('.test.ts'))

test('the tool views directory is not empty (guards against a silently passing check)', () => {
  assert.ok(sources.length > 0, 'no tool view sources were found to check')
})

for (const file of sources) {
  test(`${file} does not require host context that a standalone route cannot provide`, () => {
    const source = readFileSync(join(dir, file), 'utf8')
    for (const hook of FORBIDDEN) {
      // useOptionalOverlay contains "useOverlay" as a substring — match the
      // call, not the name.
      const called = new RegExp(`(^|[^a-zA-Z])${hook}\\s*\\(`).test(source)
      assert.equal(
        called,
        false,
        `${file} calls ${hook}(), which throws where its provider is absent. ` +
          'Use useCanvasNodes() or useOptionalOverlay(), which return null instead.',
      )
    }
  })
}

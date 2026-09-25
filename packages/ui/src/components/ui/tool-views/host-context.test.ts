// Tool views must read their host only through useToolViewHost().
//
// A tool view is rendered by the chat surface, and the chat surface is mounted
// on more than one host: the canvas overlay, which has a ReactFlowProvider and
// an OverlayProvider above it, and standalone chat routes, which have neither.
// A hook that requires either one throws where it is missing, and React
// unmounts the whole route. A single tool call then made the page unopenable,
// permanently, because the transcript replays that message from stored history
// on every visit.
//
// The views now get everything product-specific from one host interface, which
// the app provides inside the error boundary around each view. So the rule is
// stricter than "no hook that throws": no view reaches past that interface for
// a canvas, an overlay or a store of its own, and none imports from the app.
//
// This is a source check rather than a render test on purpose: it catches the
// whole class, including a view added later, instead of only the cases someone
// remembered to render.

import assert from 'node:assert/strict'
import { readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import test from 'node:test'

// Calls a view must not make. The first two throw where their provider is
// absent; the other two are the app's own access to the same context, which
// belongs to the host adapter now.
const FORBIDDEN_CALLS = ['useReactFlow', 'useOverlay', 'useCanvasNodes', 'useOptionalOverlay']

// Names and specifiers a view must not mention at all: the app's event store,
// and anything under the app's own tree.
const FORBIDDEN_TEXT = ['sseEventsStore', "'@/app/", '"@/app/']

// useOptionalOverlay contains "useOverlay" as a substring, so match the call,
// not the name.
function calls(source: string, hook: string): boolean {
  return new RegExp(`(^|[^a-zA-Z])${hook}\\s*\\(`).test(source)
}

const dir = import.meta.dirname
const sources = readdirSync(dir).filter((f) => (f.endsWith('.ts') || f.endsWith('.tsx')) && !f.endsWith('.test.ts'))

test('the tool views directory is not empty (guards against a silently passing check)', () => {
  assert.ok(sources.length > 0, 'no tool view sources were found to check')
})

test('the matchers catch what they are meant to catch (guards against a check that can never fail)', () => {
  assert.equal(calls('const canvas = useCanvasNodes()', 'useCanvasNodes'), true)
  assert.equal(calls('useOptionalOverlay({ content })', 'useOverlay'), false)
  const appImport = "import { x } from '@/app/_authed/x'"
  assert.ok(
    FORBIDDEN_TEXT.some((text) => appImport.includes(text)),
    'an import from the app tree is not caught',
  )
})

test('the views and their chrome do read the host through useToolViewHost()', () => {
  for (const file of ['tool-views.tsx', 'op-block.tsx']) {
    const source = readFileSync(join(dir, file), 'utf8')
    assert.ok(calls(source, 'useToolViewHost'), `${file} does not call useToolViewHost()`)
  }
})

for (const file of sources) {
  test(`${file} reads its host only through useToolViewHost()`, () => {
    const source = readFileSync(join(dir, file), 'utf8')
    for (const hook of FORBIDDEN_CALLS) {
      assert.equal(
        calls(source, hook),
        false,
        `${file} calls ${hook}(). Read the host through useToolViewHost() instead.`,
      )
    }
    for (const text of FORBIDDEN_TEXT) {
      assert.equal(
        source.includes(text),
        false,
        `${file} mentions ${text}. Read the host through useToolViewHost() instead.`,
      )
    }
  })
}

// Reproduces the registration-timing defect against the REAL extensionRegistry
// singleton, not a reimplementation: an extension's command modes are
// registered asynchronously (a dynamic `import()` of its client bundle
// resolves after the initial render), but `useMemo(fn, [])` captures whatever
// the registry returned at first render and never recomputes for that
// component instance again -- no matter how many times it re-renders
// afterward, or why. `allNodes`/`commandNodes` next to this same overlay in
// flow-editor.tsx avoid it by keying their memo on `extensionsVersion`, a
// counter bumped once extension loading settles; this file proves the same
// keying is what's missing here, and that adding it is sufficient.
import assert from 'node:assert/strict'
import test, { after } from 'node:test'

import { installDomEnvironment } from '@/test-support/dom-environment'

const dom = await installDomEnvironment()

const { act, createElement, useMemo, useState } = await import('react')
const { createRoot } = await import('react-dom/client')
const { extensionRegistry } = await import('@/app/_authed/(extension-runtime)/_client/registry')

after(() => dom.cleanup())

function fakeCommandModeDecl(id: string) {
  return {
    manifest: { id: `test/${id}` },
    commandModes: [{ id, label: id, component: () => null }],
  } as Parameters<typeof extensionRegistry.register>[0]
}

test('a useMemo keyed on [] never sees a mode registered after first render', async () => {
  extensionRegistry.clear()
  let bump = () => {}

  function Harness() {
    const [, setTick] = useState(0)
    bump = () => setTick((t) => t + 1)
    // Mirrors canvas-overlay.tsx's current `extensionModes` line exactly.
    const modes = useMemo(() => extensionRegistry.allCommandModes(), [])
    return createElement('div', { 'data-testid': 'count' }, String(modes.length))
  }

  const root = createRoot(dom.container)
  await act(async () => root.render(createElement(Harness)))
  assert.equal(dom.container.textContent, '0', 'nothing registered yet at first render')

  // The async bundle import resolving and registering, exactly as it does in
  // production -- well after the overlay's first render.
  extensionRegistry.register(fakeCommandModeDecl('late-mode'))
  // A re-render for ANY unrelated reason (the bug is not "it never re-renders" --
  // plenty of other state changes cause CanvasOverlay to re-render in a real
  // session; the point is that this specific memo ignores all of them).
  await act(async () => bump())

  assert.equal(
    dom.container.textContent,
    '0',
    "a memo keyed on [] must never see the late registration, by React's own useMemo contract",
  )

  await act(async () => root.unmount())
})

test('keying the same memo on a version counter picks up the late registration', async () => {
  extensionRegistry.clear()
  let commit = (_v: number) => {}

  function Harness({ extensionsVersion }: { extensionsVersion: number }) {
    const modes = useMemo(() => extensionRegistry.allCommandModes(), [extensionsVersion])
    return createElement('div', { 'data-testid': 'count' }, String(modes.length))
  }

  function Root() {
    const [version, setVersion] = useState(0)
    commit = setVersion
    return createElement(Harness, { extensionsVersion: version })
  }

  const root = createRoot(dom.container)
  await act(async () => root.render(createElement(Root)))
  assert.equal(dom.container.textContent, '0')

  extensionRegistry.register(fakeCommandModeDecl('late-mode'))
  // The production fix: the effect that awaits extension loading bumps this
  // counter once loading settles, the same signal allNodes/commandNodes
  // already key on.
  await act(async () => commit(1))

  assert.equal(dom.container.textContent, '1', 'the version bump must surface the late registration')

  await act(async () => root.unmount())
})

extensionRegistry.clear()

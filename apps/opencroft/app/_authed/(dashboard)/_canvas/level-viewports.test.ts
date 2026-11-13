// The canvas fits a level with `useLevelViewports` asking for the pending fit
// of `useFitWhenMeasured`. These run both through the real flow library, held
// the way the editor holds them: a level opened by the URL, by opening it from
// the top, or by going back up is fitted once its nodes are measured, by the
// fit of the render that sees the visible area, and a level shown before gets
// its own view back.
import assert from 'node:assert/strict'
import test, { after } from 'node:test'

import { installDomEnvironment } from '@/test-support/dom-environment'

const dom = await installDomEnvironment()

class FakeResizeObserver {
  observe() {}
  unobserve() {}
  disconnect() {}
}
;(globalThis as unknown as { ResizeObserver: unknown }).ResizeObserver = FakeResizeObserver
;(globalThis.window as unknown as { ResizeObserver: unknown }).ResizeObserver = FakeResizeObserver

class FakeDOMMatrixReadOnly {
  a = 1
  b = 0
  c = 0
  d = 1
  e = 0
  f = 0
}
;(globalThis as unknown as { DOMMatrixReadOnly: unknown }).DOMMatrixReadOnly = FakeDOMMatrixReadOnly
;(globalThis.window as unknown as { DOMMatrixReadOnly: unknown }).DOMMatrixReadOnly = FakeDOMMatrixReadOnly
;(globalThis as unknown as { SVGElement: unknown }).SVGElement = (
  globalThis.window as unknown as { SVGElement: unknown }
).SVGElement

const { act, createElement, Fragment, useCallback, useState } = await import('react')
const { createRoot } = await import('react-dom/client')
const { ReactFlow, ReactFlowProvider } = await import('@xyflow/react')
type Node = import('@xyflow/react').Node
const { fitViewOnOpen, useFitWhenMeasured } = await import('@/app/_authed/(dashboard)/_canvas/fit-view-on-open')
const { useLevelViewports } = await import('@/app/_authed/(dashboard)/_canvas/level-viewports')

after(() => dom.cleanup())

const SUB = 'sub'

// Two nodes on the top level and two on the subgraph's level. A node off the
// open level is hidden, as the editor hands them to the flow; a node counts as
// measured only with its sizes, which the test DOM can't lay out.
function graph(level: string | undefined, measured: boolean): Node[] {
  const at = (id: string, nodeLevel: string | undefined, x: number): Node => ({
    id,
    position: { x, y: 0 },
    data: {},
    hidden: nodeLevel !== level,
    ...(measured ? { measured: { width: 200, height: 100 } } : {}),
  })
  return [at('a', undefined, 0), at('b', undefined, 400), at('s1', SUB, -300), at('s2', SUB, 300)]
}

const settle = () => new Promise((resolve) => setTimeout(resolve, 20))

// `ready: false` is a graph loading in the editor in place of the one shown.
type Step = { level: string | undefined; nodes: Node[]; fitOnOpen?: boolean; ready?: boolean }
type Fit = { level: string | undefined; area: boolean }

// The editor's arrangement: the component rendering the flow holds the nodes,
// the open level and the pending fit; a graph's open sets the nodes and the
// pending fit in one update; the panel a fit aims at mounts with the graph,
// reaching the fit through state set from its ref. Each step changes what it
// names. Returns every fit made, with the level it was on and whether it saw
// the panel, after each step.
async function fitsAfter(steps: Step[]) {
  const fits: Fit[] = []
  let apply: (step: Step) => void = () => {}
  function Editor() {
    const [state, setState] = useState({
      nodes: [] as Node[],
      level: undefined as string | undefined,
      ready: false,
      pending: false,
    })
    const [panel, setPanel] = useState<HTMLDivElement | null>(null)
    apply = ({ level, nodes, fitOnOpen, ready = true }) =>
      setState((s) => ({ nodes, level, ready, pending: fitOnOpen ?? s.pending }))
    const fit = useCallback(() => {
      setState((s) => ({ ...s, pending: false }))
      fits.push({ level: state.level, area: panel !== null })
    }, [state.level, panel])
    useFitWhenMeasured(state.pending, fit)
    const arrived = useCallback((fitLevel: boolean) => {
      if (fitLevel) {
        setState((s) => ({ ...s, pending: true }))
      }
    }, [])
    useLevelViewports({ ready: state.ready, level: state.level, arrived })
    return createElement(
      Fragment,
      null,
      createElement(ReactFlow, { nodes: state.nodes, edges: [] }),
      state.ready ? createElement('div', { ref: setPanel }) : null,
    )
  }
  const root = createRoot(dom.container)
  const seen: Fit[][] = []
  try {
    await act(async () => {
      root.render(createElement(ReactFlowProvider, null, createElement(Editor)))
      await settle()
    })
    for (const step of steps) {
      await act(async () => {
        apply(step)
        await settle()
      })
      seen.push([...fits])
    }
    return seen
  } finally {
    await act(async () => root.unmount())
  }
}

const panelFit = (level: string | undefined): Fit => ({ level, area: true })

test('a level opened by its URL is fitted once, when measured, in the visible area', async () => {
  const opening = graph(SUB, false)
  assert.deepEqual(
    await fitsAfter([
      { level: SUB, nodes: opening, fitOnOpen: fitViewOnOpen(opening) },
      { level: SUB, nodes: graph(SUB, true) },
    ]),
    [[], [panelFit(SUB)]],
  )
})

test('going up from a level opened by its URL fits the top level, never shown before', async () => {
  const opening = graph(SUB, true)
  const fits = await fitsAfter([
    { level: SUB, nodes: opening, fitOnOpen: fitViewOnOpen(opening) },
    { level: undefined, nodes: graph(undefined, true) },
  ])
  assert.deepEqual(fits.at(-1), [panelFit(SUB), panelFit(undefined)])
})

test('a level opened from the top is fitted the first time and shown as it was after that', async () => {
  const opening = graph(undefined, true)
  const fits = await fitsAfter([
    { level: undefined, nodes: opening, fitOnOpen: fitViewOnOpen(opening) },
    // Opened: its nodes are measured once the flow draws them.
    { level: SUB, nodes: graph(SUB, false) },
    { level: SUB, nodes: graph(SUB, true) },
    { level: undefined, nodes: graph(undefined, true) },
    { level: SUB, nodes: graph(SUB, true) },
  ])
  assert.deepEqual(
    fits.map((f) => f.length),
    [1, 1, 2, 2, 2],
  )
  assert.deepEqual(fits.at(-1), [panelFit(undefined), panelFit(SUB)])
})

test('a graph that opens empty is not fitted when its first nodes are added', async () => {
  // The open's own rule (fitViewOnOpen), held with the levels' hook in place:
  // the level the canvas opens on asks for no fit of its own.
  const fits = await fitsAfter([
    { level: undefined, nodes: [], fitOnOpen: fitViewOnOpen([]) },
    { level: undefined, nodes: graph(undefined, true) },
  ])
  assert.deepEqual(fits, [[], []])
})

test('a graph opening empty after a subgraph level of another graph is not fitted when nodes are added', async () => {
  // The editor keeps its state across a graph switch: the levels of the graph
  // left are no levels of the next one.
  const opening = graph(SUB, true)
  const fits = await fitsAfter([
    { level: SUB, nodes: opening, fitOnOpen: fitViewOnOpen(opening) },
    { level: undefined, nodes: [], ready: false },
    { level: undefined, nodes: [], fitOnOpen: fitViewOnOpen([]) },
    { level: undefined, nodes: graph(undefined, true) },
  ])
  assert.deepEqual(fits.at(0), [panelFit(SUB)])
  assert.deepEqual(fits.at(-1), [panelFit(SUB)])
})

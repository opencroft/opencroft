// The canvas fits with `useFitWhenMeasured(fitViewOnOpen(nodes it opened
// with), fit)`. These run that rule through the real flow library: a node
// added to a graph that opened empty (a paste, a node from the menu) must not
// fit the view, a graph that opens with nodes is fitted to them, once, and
// never before they are measured.
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

const { act, createElement, useCallback, useState } = await import('react')
const { createRoot } = await import('react-dom/client')
const { ReactFlow, ReactFlowProvider } = await import('@xyflow/react')
type Node = import('@xyflow/react').Node
const { fitViewOnOpen, useFitWhenMeasured } = await import('@/app/_authed/(dashboard)/_canvas/fit-view-on-open')

after(() => dom.cleanup())

// Sizes given up front: the test DOM has no layout to measure them from, and
// a node counts as measured only with them.
function sized(id: string, x: number, y: number): Node {
  return { id, position: { x, y }, data: {}, measured: { width: 200, height: 100 } }
}

const settle = () => new Promise((resolve) => setTimeout(resolve, 20))

type Step = { nodes: Node[]; fitOnOpen?: boolean }

// Holds the canvas the way the editor does: the component that renders the
// flow keeps its nodes and the pending fit in state, calls the hook, and sets
// both in one update when a graph opens. A step without `fitOnOpen` changes
// only the nodes. Returns how many times the canvas was fitted after each step.
async function fitsAfter(steps: Step[]) {
  let count = 0
  let apply: (step: Step) => void = () => {}
  function Editor() {
    const [graph, setGraph] = useState({ nodes: [] as Node[], pending: false })
    apply = ({ nodes, fitOnOpen }) => setGraph((g) => ({ nodes, pending: fitOnOpen ?? g.pending }))
    const fit = useCallback(() => {
      setGraph((g) => ({ ...g, pending: false }))
      count += 1
    }, [])
    useFitWhenMeasured(graph.pending, fit)
    return createElement(ReactFlow, { nodes: graph.nodes, edges: [] })
  }
  const root = createRoot(dom.container)
  const counts: number[] = []
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
      counts.push(count)
    }
    return counts
  } finally {
    await act(async () => root.unmount())
  }
}

const added = [sized('a', 4000, 3000), sized('b', 4300, 3200)]

test('nodes added to a graph that opened empty are not fitted', async () => {
  const opening: Node[] = []
  assert.deepEqual(await fitsAfter([{ nodes: opening, fitOnOpen: fitViewOnOpen(opening) }, { nodes: added }]), [0, 0])
})

test('a graph that opens with nodes is fitted to them, once', async () => {
  // The same nodes again, as new objects: nothing fits a second time.
  assert.deepEqual(
    await fitsAfter([{ nodes: added, fitOnOpen: fitViewOnOpen(added) }, { nodes: added.map((n) => ({ ...n })) }]),
    [1, 1],
  )
})

test('a fit still pending on an empty open runs on the first nodes added', async () => {
  // The hazard the rule exists for. If this fails, the fit does not wait past
  // an empty open, and the first test above proves nothing.
  assert.deepEqual(await fitsAfter([{ nodes: [], fitOnOpen: true }, { nodes: added }]), [0, 1])
})

test('a graph opened in place of a measured one is fitted only once its own nodes are measured', async () => {
  // The editor stays mounted when it switches graphs: the new nodes and the
  // pending fit arrive in one update, while the old graph's nodes are still
  // the measured ones.
  const other = [sized('c', -900, -600), sized('d', -500, -400)]
  const unmeasured = other.map(({ measured: _, ...n }) => n)
  assert.deepEqual(
    await fitsAfter([{ nodes: added, fitOnOpen: true }, { nodes: unmeasured, fitOnOpen: true }, { nodes: other }]),
    [1, 1, 2],
  )
})

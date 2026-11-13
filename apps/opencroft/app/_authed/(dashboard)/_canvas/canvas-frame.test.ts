// A frame node's border keeps its width on screen at any zoom. A frame in
// error says so the way a node card does: a warning icon and its label in the
// destructive colour, and none of the error's text. The frame a drag would
// drop into is highlighted. These
// tests render the real CanvasFrame inside a ReactFlow provider holding the
// frame's node, since the frame reads the node's errors from there.
import assert from 'node:assert/strict'
import test, { after, afterEach } from 'node:test'

import { installDomEnvironment } from '@/test-support/dom-environment'

const dom = await installDomEnvironment()

const win = globalThis.window as unknown as Window & typeof globalThis

const { act, createElement, useEffect } = await import('react')
const { createRoot } = await import('react-dom/client')
const { ReactFlowProvider, useStoreApi } = await import('@xyflow/react')
const { Network } = await import('lucide-react')
const { CanvasFrame, FRAME_BORDER_PX } = await import('./canvas-frame')
const { DropTargetContext } = await import('./drop-target-context')

type Root = ReturnType<typeof createRoot>

const roots: Root[] = []

afterEach(async () => {
  for (const root of roots.splice(0)) {
    await act(async () => root.unmount())
  }
  dom.container.replaceChildren()
})

after(() => dom.cleanup())

const ACCENT = 'rgb(1, 2, 3)'

/** Sets the canvas zoom in the store the frame reads, as zooming the canvas does. */
function Zoom({ zoom }: { zoom: number }) {
  const store = useStoreApi()
  useEffect(() => store.setState({ transform: [0, 0, zoom] }), [store, zoom])
  return null
}

async function renderFrame(
  data: Record<string, unknown>,
  {
    zoom = 1,
    selected = false,
    dropTargets = new Set(),
  }: { zoom?: number; selected?: boolean; dropTargets?: ReadonlySet<string> } = {},
): Promise<HTMLElement> {
  const container = win.document.createElement('div')
  dom.container.appendChild(container)
  const root = createRoot(container)
  roots.push(root)
  const node = { id: 'frame-1', type: 'acme.frame', position: { x: 0, y: 0 }, data }
  await act(async () => {
    root.render(
      createElement(ReactFlowProvider, {
        initialNodes: [node],
        children: [
          createElement(Zoom, { key: 'zoom', zoom }),
          createElement(DropTargetContext.Provider, {
            key: 'frame',
            value: dropTargets,
            children: createElement(CanvasFrame, {
              id: 'frame-1',
              selected,
              color: ACCENT,
              icon: Network,
              label: 'Backend',
            }),
          }),
        ],
      }),
    )
  })
  return container
}

/** The frame's tinted, bordered body. */
function body(container: HTMLElement): HTMLElement {
  const el = label(container).closest('.rounded-lg')
  assert.ok(el, 'the frame body renders')
  return el as HTMLElement
}

function label(container: HTMLElement): HTMLElement {
  const span = [...container.querySelectorAll('span')].find((el) => el.textContent === 'Backend')
  assert.ok(span, 'the frame label renders')
  return span as HTMLElement
}

test('a frame without errors shows its own icon and its label in its colour', async () => {
  const container = await renderFrame({})
  assert.equal(label(container).style.color, ACCENT)
  assert.ok(container.querySelector('svg.lucide-network'), 'the type icon renders')
})

test('the border keeps its width on screen: the zoom times its canvas width is the same at every zoom', async () => {
  for (const zoom of [0.25, 0.5, 1]) {
    const width = Number.parseFloat(body(await renderFrame({}, { zoom })).style.borderWidth)
    assert.equal(width * zoom, FRAME_BORDER_PX, `at zoom ${zoom} the border is ${width} canvas px`)
  }
})

test('the border is dashed in a tint of the frame colour, and solid in the full colour while selected', async () => {
  const idle = body(await renderFrame({}))
  assert.ok(idle.classList.contains('border-dashed'))
  assert.match(idle.style.borderColor, /color-mix/)
  const selected = body(await renderFrame({}, { selected: true }))
  assert.ok(selected.classList.contains('border-solid'))
  assert.equal(selected.style.borderColor, ACCENT)
})

test('the frame a drag would drop into has a solid border in the full colour and a deeper tint', async () => {
  const idle = body(await renderFrame({}, { dropTargets: new Set(['another-frame']) }))
  assert.ok(idle.classList.contains('border-dashed'))
  assert.match(idle.style.backgroundColor, / 8%/)
  const target = body(await renderFrame({}, { dropTargets: new Set(['frame-1']) }))
  assert.ok(target.classList.contains('border-solid'))
  assert.equal(target.style.borderColor, ACCENT)
  assert.match(target.style.backgroundColor, / 16%/)
})

test('a frame with errors shows the warning icon and a destructive label, and not the error text', async () => {
  const container = await renderFrame({ __errors: [{ source: 'check', title: 'Network name refused' }] })
  assert.equal(label(container).style.color, 'var(--destructive)')
  assert.equal(container.querySelector('svg.lucide-network'), null)
  assert.ok(container.querySelector('svg[class*="triangle-alert"], svg[class*="alert-triangle"]'))
  assert.doesNotMatch(container.textContent ?? '', /Network name refused/)
})

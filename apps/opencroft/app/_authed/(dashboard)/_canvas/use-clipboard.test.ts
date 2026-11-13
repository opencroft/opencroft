// The pane context menu needs Paste at the menu-invocation position (not
// the small fixed offset the keyboard shortcut uses, which has no "where
// you clicked" to speak of), and paste() previously wasn't even reachable
// outside the keyboard handler -- useClipboard's own ClipboardControls only
// returned `copy`. Separately, neither copy nor paste had any error
// handling at all: navigator.clipboard access is markedly less reliable on
// mobile browsers, and an unhandled rejection there was indistinguishable
// from "nothing was selected" -- a silent-failure class this file used to
// share with the touch-tap bugs elsewhere in this area. This exercises both
// against a real DOM and a real React hook (not a reimplementation of the
// logic under test).
import assert from 'node:assert/strict'
import test, { after, beforeEach } from 'node:test'

import type { Node } from '@xyflow/react'

import type { CanvasView } from '@/app/_authed/(dashboard)/_canvas/use-clipboard'
import { SUBGRAPH_TYPE } from '@/app/_authed/(extension-runtime)/_builtin/core/src/nodes/subgraph-shared'
import { installDomEnvironment } from '@/test-support/dom-environment'

const dom = await installDomEnvironment()

const { act, createElement, Fragment, useRef, useState } = await import('react')
const { createRoot } = await import('react-dom/client')
const { forgetCopiedNodes, useClipboard } = await import('./use-clipboard')

after(() => dom.cleanup())
// Each test starts on a page where nothing has been copied yet.
beforeEach(() => forgetCopiedNodes())

function makeNode(id: string, x: number, y: number, selected = false): Node {
  return { id, type: 'default', position: { x, y }, data: {}, selected }
}

const FRAME_TYPE = 'test.frame'

function makeFrame(id: string, x: number, y: number, selected = false): Node {
  return { ...makeNode(id, x, y, selected), type: FRAME_TYPE, style: { width: 400, height: 300 } }
}

interface ClipboardHandle {
  copy: () => Promise<void>
  paste: (target?: { x: number; y: number }) => Promise<void>
  hasCopiedNodes: () => boolean
  nodes: () => ReturnType<typeof makeNode>[]
}

function installFakeClipboard(): { setReadFailure: (fail: boolean) => void; setWriteFailure: (fail: boolean) => void } {
  let store = ''
  let failRead = false
  let failWrite = false
  ;(globalThis.navigator as unknown as { clipboard: unknown }).clipboard = {
    writeText: async (text: string) => {
      if (failWrite) {
        throw new Error('write denied')
      }
      store = text
    },
    readText: async () => {
      if (failRead) {
        throw new Error('read denied')
      }
      return store
    },
  }
  return {
    setReadFailure: (fail: boolean) => {
      failRead = fail
    },
    setWriteFailure: (fail: boolean) => {
      failWrite = fail
    },
  }
}

async function mountHarness(
  initialNodes: ReturnType<typeof makeNode>[],
  findTakenIds: (ids: string[]) => Promise<string[]> = async () => [],
  view: () => CanvasView = () => ({ centre: { x: 0, y: 0 }, transform: [0, 0, 1] }),
) {
  const handleRef = { current: null as ClipboardHandle | null }

  function Harness() {
    const [nodes, setNodesState] = useState(initialNodes)
    const nodesRef = useRef(nodes)
    nodesRef.current = nodes
    const [edges, setEdgesState] = useState<unknown[]>([])
    const controls = useClipboard({
      findTakenIds,
      nodes,
      edges: edges as never,
      setNodes: (updater) => setNodesState((nds) => updater(nds)),
      setEdges: (updater) => setEdgesState((eds) => updater(eds as never)),
      onChange: () => {},
      view,
      isFrame: (n) => n.type === FRAME_TYPE,
    })

    // Written directly on every render rather than via a ref prop -- this
    // harness has no parent component to forward a ref through, and the
    // handle only needs to be readable between act() calls, not during one.
    handleRef.current = {
      copy: controls.copy,
      paste: controls.paste,
      hasCopiedNodes: () => controls.hasCopiedNodes,
      nodes: () => nodesRef.current,
    }

    // The canvas the shortcuts are bound to, with the kinds of thing that can
    // hold focus inside it, and beside it an inspector whose code editor is a
    // plain focusable div -- what Monaco's EditContext input is on the page.
    return createElement(
      Fragment,
      null,
      createElement(
        'div',
        { 'data-testid': 'canvas', tabIndex: -1, onKeyDown: controls.onKeyDown },
        createElement('div', { 'data-testid': 'node', tabIndex: 0 }, 'node text'),
        createElement('input', { 'data-testid': 'node-input' }),
        createElement('div', {
          'data-testid': 'node-editable',
          contentEditable: true,
          suppressContentEditableWarning: true,
        }),
        createElement('div', { className: 'nokey' }, createElement('div', { 'data-testid': 'node-code', tabIndex: 0 })),
      ),
      createElement('div', { 'data-testid': 'inspector-code', tabIndex: 0 }),
    )
  }

  // A host of its own per mount, so one test's elements are never found by the next.
  const host = document.createElement('div')
  dom.container.append(host)
  const root = createRoot(host)
  after(() => act(() => root.unmount()))
  await act(async () => {
    root.render(createElement(Harness, null))
  })

  assert.ok(handleRef.current, 'expected the clipboard harness to mount')
  // Every call goes through current() fresh, not a one-time snapshot --
  // copy/paste are useCallback-memoized on `nodes`, which changes after
  // each mutation, so a call made from a stale closure would silently act
  // on the state as of mount instead of the latest render.
  function current(): ClipboardHandle {
    assert.ok(handleRef.current, 'expected the clipboard harness to still be mounted')
    return handleRef.current
  }
  return {
    copy: () => current().copy(),
    paste: (target?: { x: number; y: number }) => current().paste(target),
    hasCopiedNodes: () => current().hasCopiedNodes(),
    nodes: () => current().nodes(),
    element: (testId: string): HTMLElement => {
      const el = host.querySelector<HTMLElement>(`[data-testid="${testId}"]`)
      assert.ok(el, `expected the harness to render ${testId}`)
      return el
    },
  }
}

/** Presses a Ctrl shortcut on `target`; true when something took it from the browser. */
async function pressOn(target: HTMLElement, code: string, key: string, init: KeyboardEventInit = {}): Promise<boolean> {
  const event = new globalThis.window.KeyboardEvent('keydown', {
    code,
    key,
    ctrlKey: true,
    bubbles: true,
    cancelable: true,
    ...init,
  })
  await act(async () => {
    target.dispatchEvent(event)
  })
  return event.defaultPrevented
}

test('copy with no selection does not mark the clipboard as holding anything', async () => {
  installFakeClipboard()
  const h = await mountHarness([makeNode('a', 0, 0, false)])
  await act(async () => {
    await h.copy()
  })
  assert.equal(h.hasCopiedNodes(), false)
})

test('copy then paste at a target position lands the group there, keeping relative layout', async () => {
  installFakeClipboard()
  const h = await mountHarness([makeNode('a', 100, 100, true), makeNode('b', 150, 130, true)])
  await act(async () => {
    await h.copy()
  })
  assert.equal(h.hasCopiedNodes(), true)

  await act(async () => {
    await h.paste({ x: 500, y: 500 })
  })

  const pasted = h.nodes().filter((n) => n.id !== 'a' && n.id !== 'b')
  assert.equal(pasted.length, 2, 'both copied nodes should be pasted')
  const xs = pasted.map((n) => n.position.x).sort((a, b) => a - b)
  const ys = pasted.map((n) => n.position.y).sort((a, b) => a - b)
  assert.equal(xs[0], 500, "the group's leftmost node lands exactly on the target x")
  assert.equal(ys[0], 500, "the group's topmost node lands exactly on the target y")
  // Original relative offset between the two copied nodes (50, 30) must survive.
  assert.equal(xs[1] - xs[0], 50)
  assert.equal(ys[1] - ys[0], 30)
})

function sized(id: string, x: number, y: number, width: number, height: number): Node {
  return { ...makeNode(id, x, y, true), measured: { width, height } }
}

test('paste with no target centres the group on the viewport, keeping its layout', async () => {
  installFakeClipboard()
  const view: CanvasView = { centre: { x: 1000, y: 2000 }, transform: [0, 0, 1] }
  const h = await mountHarness(
    [sized('a', -5000, -5000, 100, 40), sized('b', -4900, -4900, 100, 40)],
    undefined,
    () => view,
  )
  await act(async () => {
    await h.copy()
  })
  await act(async () => {
    await h.paste()
  })
  const pasted = h.nodes().filter((n) => n.id !== 'a' && n.id !== 'b')
  // The group's box is 200 by 140, so its centre (1000, 2000) puts its top-left at (900, 1930).
  assert.deepEqual(
    pasted.map((n) => n.position),
    [
      { x: 900, y: 1930 },
      { x: 1000, y: 2030 },
    ],
  )
})

test('pasting again into the same view moves each copy one grid step on, and a pan starts over', async () => {
  installFakeClipboard()
  let view: CanvasView = { centre: { x: 0, y: 0 }, transform: [0, 0, 1] }
  const h = await mountHarness([sized('a', 500, 500, 100, 100)], undefined, () => view)
  await act(async () => {
    await h.copy()
  })
  for (let i = 0; i < 3; i++) {
    await act(async () => {
      await h.paste()
    })
  }
  view = { centre: { x: 300, y: 300 }, transform: [-300, -300, 1] }
  await act(async () => {
    await h.paste()
  })
  assert.deepEqual(
    h
      .nodes()
      .slice(1)
      .map((n) => n.position),
    [
      { x: -50, y: -50 },
      { x: -40, y: -40 },
      { x: -30, y: -30 },
      { x: 250, y: 250 },
    ],
  )
})

// Pasting selects the copy, which opens the inspector beside the canvas and
// narrows the pane: its centre moves though the person moved nothing.
test('a pane that only changes size between pastes still steps each copy on from the last', async () => {
  installFakeClipboard()
  let view: CanvasView = { centre: { x: 700, y: 450 }, transform: [0, 0, 1] }
  const h = await mountHarness([sized('a', 5000, 5000, 100, 100)], undefined, () => view)
  await act(async () => {
    await h.copy()
  })
  await act(async () => {
    await h.paste()
  })
  view = { centre: { x: 490, y: 450 }, transform: [0, 0, 1] }
  await act(async () => {
    await h.paste()
  })
  view = { centre: { x: 700, y: 450 }, transform: [0, 0, 1] }
  await act(async () => {
    await h.paste()
  })
  assert.deepEqual(
    h
      .nodes()
      .slice(1)
      .map((n) => n.position),
    [
      { x: 650, y: 400 },
      { x: 660, y: 410 },
      { x: 670, y: 420 },
    ],
  )
})

test('a copy in one editor makes Paste available in another', async () => {
  installFakeClipboard()
  const source = await mountHarness([makeNode('a', 0, 0, true)])
  const target = await mountHarness([])
  assert.equal(target.hasCopiedNodes(), false)
  await act(async () => {
    await source.copy()
  })
  assert.equal(target.hasCopiedNodes(), true)
})

test('a child copied without its parent is pasted top-level, where it was drawn', async () => {
  installFakeClipboard()
  const parent = makeNode('frame', 1000, 1000, false)
  const child: Node = { ...makeNode('child', 20, 30, true), parentId: 'frame', extent: 'parent' }
  const h = await mountHarness([parent, child])
  await act(async () => {
    await h.copy()
  })
  await act(async () => {
    await h.paste({ x: 200, y: 100 })
  })
  const pasted = h.nodes()[2]
  assert.ok(pasted)
  assert.equal(pasted.parentId, undefined)
  assert.equal(pasted.extent, undefined)
  assert.deepEqual(pasted.position, { x: 200, y: 100 })
})

test('a child pasted with its parent keeps its place inside it', async () => {
  installFakeClipboard()
  const parent = makeNode('frame', 1000, 1000, true)
  // Below the frame's title band, so the frame holds it as it is.
  const child: Node = { ...makeNode('child', 20, 40, true), parentId: 'frame' }
  const h = await mountHarness([parent, child])
  await act(async () => {
    await h.copy()
  })
  await act(async () => {
    await h.paste({ x: 200, y: 100 })
  })
  const [pastedParent, pastedChild] = h.nodes().slice(2)
  assert.ok(pastedParent && pastedChild)
  assert.deepEqual(pastedParent.position, { x: 200, y: 100 })
  assert.equal(pastedChild.parentId, pastedParent.id)
  assert.deepEqual(pastedChild.position, { x: 20, y: 40 })
})

test('a node pasted onto a frame goes into it, at its place relative to the frame', async () => {
  installFakeClipboard()
  const h = await mountHarness([makeFrame('f', 1000, 1000), makeNode('a', 0, 0, true)])
  await act(async () => {
    await h.copy()
  })
  await act(async () => {
    await h.paste({ x: 1100, y: 1050 })
  })
  const pasted = h.nodes().find((n) => !['f', 'a'].includes(n.id))
  assert.equal(pasted?.parentId, 'f')
  assert.deepEqual(pasted?.position, { x: 100, y: 50 })
})

test('a clipboard without parents pastes its frames holding what lies in them', async () => {
  installFakeClipboard()
  // What a copy made before frames had members holds: every position absolute, no parentId.
  await navigator.clipboard.writeText(
    JSON.stringify({
      format: 'opencroft/nodes',
      nodes: [makeFrame('old-frame', 0, 0), makeNode('old-node', 40, 60)],
      edges: [],
    }),
  )
  const h = await mountHarness([])
  await act(async () => {
    await h.paste({ x: 500, y: 500 })
  })
  const [frame, node] = h.nodes()
  assert.equal(frame?.parentId, undefined)
  assert.deepEqual(frame?.position, { x: 500, y: 500 })
  assert.equal(node?.parentId, frame?.id)
  assert.deepEqual(node?.position, { x: 40, y: 60 })
})

test('a clipboard write rejection (e.g. denied permission on mobile) does not throw and leaves hasCopiedNodes false', async () => {
  const fake = installFakeClipboard()
  fake.setWriteFailure(true)
  const h = await mountHarness([makeNode('a', 0, 0, true)])
  await act(async () => {
    await assert.doesNotReject(h.copy())
  })
  assert.equal(h.hasCopiedNodes(), false)
})

test('a clipboard read rejection on paste does not throw and pastes nothing', async () => {
  const fake = installFakeClipboard()
  const h = await mountHarness([makeNode('a', 0, 0, true)])
  await act(async () => {
    await h.copy()
  })
  fake.setReadFailure(true)
  const before = h.nodes().length
  await act(async () => {
    await assert.doesNotReject(h.paste({ x: 0, y: 0 }))
  })
  assert.equal(h.nodes().length, before, 'a failed read must not add any node')
})

// The shortcuts are matched on `event.code` (the physical key), not
// `event.key` (the character it produces), so a layout switch, which changes
// `key` but never `code`, must not turn them off.
test('Ctrl+V pastes on the physical V key even when the layout types a different character', async () => {
  installFakeClipboard()
  const h = await mountHarness([makeNode('a', 10, 10, true)])
  await act(async () => {
    await h.copy()
  })
  const before = h.nodes().length
  // A Cyrillic layout's physical V key: `code` is still "KeyV", `key` is "м".
  assert.equal(await pressOn(h.element('canvas'), 'KeyV', 'м'), true)
  assert.equal(h.nodes().length, before + 1, 'the physical key still pastes, regardless of what it types')
})

test('a different physical key does not paste just because it happens to type "v"', async () => {
  installFakeClipboard()
  const h = await mountHarness([makeNode('a', 10, 10, true)])
  await act(async () => {
    await h.copy()
  })
  const before = h.nodes().length
  assert.equal(await pressOn(h.element('canvas'), 'KeyN', 'v'), false)
  assert.equal(h.nodes().length, before, 'the wrong physical key must not paste')
})

test('Ctrl+C on a node copies the selected nodes', async () => {
  installFakeClipboard()
  const h = await mountHarness([makeNode('a', 10, 10, true)])
  assert.equal(await pressOn(h.element('node'), 'KeyC', 'c'), true)
  assert.equal(h.hasCopiedNodes(), true)
})

test('Cmd+C copies on a Mac the same as Ctrl+C', async () => {
  installFakeClipboard()
  const h = await mountHarness([makeNode('a', 10, 10, true)])
  assert.equal(await pressOn(h.element('canvas'), 'KeyC', 'c', { ctrlKey: false, metaKey: true }), true)
  assert.equal(h.hasCopiedNodes(), true)
})

// A code editor that takes input through EditContext is a plain div, not a
// form field. Outside the canvas it must keep its own paste even so.
test('Ctrl+V in an editor outside the canvas is left to the browser', async () => {
  installFakeClipboard()
  const h = await mountHarness([makeNode('a', 10, 10, true)])
  await act(async () => {
    await h.copy()
  })
  const before = h.nodes().length
  assert.equal(await pressOn(h.element('inspector-code'), 'KeyV', 'v'), false)
  assert.equal(h.nodes().length, before)
})

test('Ctrl+C, X and V in a text field, contenteditable or .nokey editor inside the canvas are left to the browser', async () => {
  installFakeClipboard()
  const h = await mountHarness([makeNode('a', 10, 10, true)])
  for (const testId of ['node-input', 'node-editable', 'node-code']) {
    for (const [code, key] of [
      ['KeyC', 'c'],
      ['KeyX', 'x'],
      ['KeyV', 'v'],
    ]) {
      assert.equal(await pressOn(h.element(testId), code, key), false, `${code} in ${testId}`)
    }
  }
  assert.equal(h.hasCopiedNodes(), false, 'nothing was copied')
  assert.deepEqual(
    h.nodes().map((n) => n.id),
    ['a'],
    'nothing was cut or pasted',
  )
})

test('Ctrl+C with text selected inside the canvas copies the text, not the nodes', async () => {
  installFakeClipboard()
  const h = await mountHarness([makeNode('a', 10, 10, true)])
  const selection = document.getSelection()
  assert.ok(selection)
  selection.selectAllChildren(h.element('node'))
  try {
    assert.equal(await pressOn(h.element('node'), 'KeyC', 'c'), false)
    assert.equal(h.hasCopiedNodes(), false)
  } finally {
    selection.removeAllRanges()
  }
})

test('Ctrl+Shift+V is left to the browser', async () => {
  installFakeClipboard()
  const h = await mountHarness([makeNode('a', 10, 10, true)])
  await act(async () => {
    await h.copy()
  })
  assert.equal(await pressOn(h.element('canvas'), 'KeyV', 'V', { shiftKey: true }), false)
  assert.equal(h.nodes().length, 1)
})

// Ids survive a move: whatever refers to a cut node (a router route, an edge
// from elsewhere) must still find it once it is pasted back.
test("cut then paste keeps the nodes' ids", async () => {
  installFakeClipboard()
  const h = await mountHarness([makeNode('a', 0, 0, true), makeNode('keep', 50, 50, false)])
  await pressOn(h.element('canvas'), 'KeyX', 'x')
  assert.deepEqual(
    h.nodes().map((n) => n.id),
    ['keep'],
  )
  await act(async () => {
    await h.paste({ x: 10, y: 10 })
  })
  assert.deepEqual(
    h.nodes().map((n) => n.id),
    ['keep', 'a'],
  )
})

test('cutting a frame leaves its members where they are drawn, in the frame it was in', async () => {
  installFakeClipboard()
  const member: Node = { ...makeNode('m', 20, 30), parentId: 'cut' }
  const inner: Node = { ...makeFrame('cut', 100, 100, true), parentId: 'outer' }
  const h = await mountHarness([makeFrame('outer', 1000, 1000), inner, member])
  await pressOn(h.element('canvas'), 'KeyX', 'x')
  const left = h.nodes().find((n) => n.id === 'm')
  assert.equal(left?.parentId, 'outer')
  assert.deepEqual(left?.position, { x: 120, y: 130 })
})

test('cut takes a subgraph with everything inside it, and paste brings it all back under the same ids', async () => {
  installFakeClipboard()
  const sub: Node = { ...makeNode('sub', 300, 300, true), type: SUBGRAPH_TYPE }
  const inside: Node = { ...makeNode('inside', -40, 60), parentId: 'sub' }
  const nested: Node = { ...makeNode('nested', 500, 500), type: SUBGRAPH_TYPE, parentId: 'sub' }
  const deep: Node = { ...makeNode('deep', 20, 30), parentId: 'nested' }
  const h = await mountHarness([sub, inside, nested, deep, makeNode('a', 0, 0)])
  await pressOn(h.element('canvas'), 'KeyX', 'x')
  assert.deepEqual(
    h.nodes().map((n) => n.id),
    ['a'],
  )
  await act(async () => {
    await h.paste({ x: 10, y: 10 })
  })
  const byId = new Map(h.nodes().map((n) => [n.id, n]))
  assert.deepEqual(
    ['inside', 'nested', 'deep'].map((id) => [byId.get(id)?.parentId, byId.get(id)?.position]),
    [
      ['sub', { x: -40, y: 60 }],
      ['sub', { x: 500, y: 500 }],
      ['nested', { x: 20, y: 30 }],
    ],
    'inside, every node keeps its parent and its place on its canvas',
  )
  assert.deepEqual(byId.get('sub')?.position, { x: 10, y: 10 })
  assert.deepEqual(
    h
      .nodes()
      .filter((n) => n.selected)
      .map((n) => n.id),
    ['sub'],
    'what the subgraph holds is off this canvas, and not selected',
  )
})

test('copy then paste into the same graph gives the copies new ids, the originals stay', async () => {
  installFakeClipboard()
  const h = await mountHarness([makeNode('a', 0, 0, true)])
  await act(async () => {
    await h.copy()
  })
  await act(async () => {
    await h.paste()
  })
  const ids = h.nodes().map((n) => n.id)
  assert.equal(ids.length, 2)
  assert.equal(ids[0], 'a')
  assert.notEqual(ids[1], 'a')
})

test('an id another graph already holds is replaced on paste', async () => {
  installFakeClipboard()
  const asked: string[][] = []
  const h = await mountHarness([makeNode('a', 0, 0, true)], async (ids) => {
    asked.push(ids)
    return ['a']
  })
  await pressOn(h.element('canvas'), 'KeyX', 'x')
  await act(async () => {
    await h.paste()
  })
  assert.deepEqual(asked, [['a']])
  const [pasted] = h.nodes()
  assert.ok(pasted)
  assert.notEqual(pasted.id, 'a')
})

test('when the id check fails the paste still happens, with fresh ids', async () => {
  installFakeClipboard()
  const h = await mountHarness([makeNode('a', 0, 0, true)], async () => {
    throw new Error('offline')
  })
  await pressOn(h.element('canvas'), 'KeyX', 'x')
  await act(async () => {
    await h.paste()
  })
  const [pasted] = h.nodes()
  assert.ok(pasted)
  assert.notEqual(pasted.id, 'a')
})

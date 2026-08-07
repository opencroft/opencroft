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
import test, { after } from 'node:test'

import type { Node } from '@xyflow/react'

import { installDomEnvironment } from '@/test-support/dom-environment'

const dom = await installDomEnvironment()

const { act, createElement, useRef, useState } = await import('react')
const { createRoot } = await import('react-dom/client')
const { useClipboard } = await import('./use-clipboard')

after(() => dom.cleanup())

function makeNode(id: string, x: number, y: number, selected = false): Node {
  return { id, type: 'default', position: { x, y }, data: {}, selected }
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

async function mountHarness(initialNodes: ReturnType<typeof makeNode>[]) {
  const handleRef = { current: null as ClipboardHandle | null }

  function Harness() {
    const [nodes, setNodesState] = useState(initialNodes)
    const nodesRef = useRef(nodes)
    nodesRef.current = nodes
    const [edges, setEdgesState] = useState<unknown[]>([])
    const controls = useClipboard({
      nodes,
      edges: edges as never,
      setNodes: (updater) => setNodesState((nds) => updater(nds)),
      setEdges: (updater) => setEdgesState((eds) => updater(eds as never)),
      onChange: () => {},
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

    return null
  }

  const root = createRoot(dom.container)
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
  }
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

test('paste with no target falls back to the small fixed offset (the keyboard-shortcut path)', async () => {
  installFakeClipboard()
  const h = await mountHarness([makeNode('a', 10, 10, true)])
  await act(async () => {
    await h.copy()
  })
  await act(async () => {
    await h.paste()
  })
  const pasted = h.nodes().find((n) => n.id !== 'a')
  assert.ok(pasted)
  assert.equal(pasted.position.x, 30)
  assert.equal(pasted.position.y, 30)
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

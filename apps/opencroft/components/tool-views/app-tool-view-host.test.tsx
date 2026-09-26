// An approval-mode diff reaches the canvas overlay through the host.
//
// A tool view no longer writes the overlay itself: it renders the host's
// ApprovalPanel, and the application's panel publishes into the overlay's
// content slot. The write therefore happens one component lower than it used
// to, in the same React commit. These pin what the overlay sees across a view's
// life: the diff arrives once there is one, follows the view's own state, and
// is cleared when the view goes away.
//
// Rendered against a real DOM because the publish is a layout effect; static
// markup never runs one.

import assert from 'node:assert/strict'
import test, { after } from 'node:test'

import type { ReactElement, ReactNode } from 'react'

import { installDomEnvironment } from '@/test-support/dom-environment'

const dom = await installDomEnvironment()

// After the DOM exists, never before — react-dom binds to the globals it finds.
const { act, createElement, isValidElement } = await import('react')
const { createRoot } = await import('react-dom/client')
const { OverlayProvider, useOverlaySlotValues } = await import('@/app/_authed/(dashboard)/_canvas/overlay-context')
const { ToolViewHostProvider, useToolViewHost } = await import('ui/tool-views/tool-view-host')
const { TOOL_VIEWS } = await import('ui/tool-views/tool-views')
const { AppToolViewHost } = await import('./app-tool-view-host')

after(() => dom.cleanup())

const FILE = 'const greeting = "hello world"\n'

// The application's host with two members replaced: reading a remote file needs
// a server and the editor needs a browser, and what is under test here is the
// application's approval panel, which is kept.
function StubDiffEditor() {
  return null
}

function WithFile({ children }: { children: ReactNode }) {
  const host = useToolViewHost()
  return createElement(
    ToolViewHostProvider,
    { host: { ...host, readFile: async () => FILE, DiffEditor: StubDiffEditor } },
    children,
  )
}

// The props of the first element in a published tree that has `key` among them.
// The tree is read as published, not rendered: the diff editor itself is never
// mounted here.
function findProps(node: unknown, key: string): Record<string, unknown> | null {
  if (!isValidElement(node)) {
    return null
  }
  const props = (node as ReactElement<Record<string, unknown>>).props
  if (key in props) {
    return props
  }
  for (const child of ([] as unknown[]).concat(props.children ?? [])) {
    const found = findProps(child, key)
    if (found) {
      return found
    }
  }
  return null
}

interface Mounted {
  painted: () => unknown
  render: (view: ReactElement | null) => Promise<void>
  unmount: () => void
}

async function mount(): Promise<Mounted> {
  let painted: unknown = null
  function Painter() {
    painted = useOverlaySlotValues().content
    return null
  }
  const root = createRoot(dom.container)
  const render = async (view: ReactElement | null) => {
    await act(async () => {
      root.render(
        createElement(
          OverlayProvider,
          null,
          view && createElement(AppToolViewHost, null, createElement(WithFile, null, view)),
          createElement(Painter, null),
        ),
      )
    })
  }
  return { painted: () => painted, render, unmount: () => act(() => root.unmount()) }
}

test('remote_edit: the approval diff is published once the file is read, and cleared on unmount', async () => {
  const RemoteEdit = TOOL_VIEWS.remote_edit.body
  const view = createElement(RemoteEdit, {
    tool: 'remote_edit',
    requestId: 'request-1',
    mode: 'approval',
    args: { target: 'node-1/terminal', path: 'greeting.ts', oldString: 'world', newString: 'there' },
  })
  const mounted = await mount()
  try {
    await mounted.render(view)
    const diff = findProps(mounted.painted(), 'original')
    assert.deepEqual(diff && { original: diff.original, value: diff.value, path: diff.path }, {
      original: FILE,
      value: FILE.replace('world', 'there'),
      path: 'greeting.ts',
    })

    await mounted.render(null)
    assert.equal(mounted.painted(), null, 'the view unmounted and its diff is still in the overlay')
  } finally {
    mounted.unmount()
  }
})

const NODE_UPDATE = { nodeId: 'node-1', data: { name: 'Renamed' } }

function updateNodes(mode: 'approval' | 'history') {
  // The 'graph.updateNodes' key is the approval queue's own path: the server
  // sets `view: 'graph.updateNodes'` on a graph write's approval and hands
  // over app_call's own args, which the view unwraps (see app-call-view.test.ts).
  return createElement(TOOL_VIEWS['graph.updateNodes'].body, {
    tool: 'app_call',
    requestId: 'request-2',
    mode,
    args: { app: 'my-space.default', action: 'updateNodes', params: { updates: [NODE_UPDATE] } },
  })
}

async function toggleFirstNode() {
  const button = dom.container.querySelector('button')
  assert.ok(button, 'the node to update is listed as a button')
  await act(async () => {
    button.click()
  })
}

test('graph.updateNodes: the overlay follows the open node, and is cleared on unmount', async () => {
  const mounted = await mount()
  try {
    await mounted.render(updateNodes('approval'))
    assert.equal(mounted.painted(), null, 'nothing is open yet, so nothing is published')

    await toggleFirstNode()
    assert.deepEqual(findProps(mounted.painted(), 'update')?.update, NODE_UPDATE, 'opening the node publishes it')

    await toggleFirstNode()
    assert.equal(mounted.painted(), null, 'closing the node withdraws it')

    await toggleFirstNode()
    assert.ok(findProps(mounted.painted(), 'update'), 'reopening the node publishes it again')
    await mounted.render(null)
    assert.equal(mounted.painted(), null, 'the view unmounted and its diff is still in the overlay')
  } finally {
    mounted.unmount()
  }
})

test('history mode publishes nothing: the transcript shows its diff inline', async () => {
  const mounted = await mount()
  try {
    await mounted.render(updateNodes('history'))
    await toggleFirstNode()
    assert.equal(mounted.painted(), null)
  } finally {
    mounted.unmount()
  }
})

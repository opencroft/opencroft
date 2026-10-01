// An extension's context-menu items are told the node's wired inputs as the
// canvas has them, so an item's enablement follows wiring done in the open
// page instead of waiting for the server to write `__resolvedContexts`.
import assert from 'node:assert/strict'
import test, { after } from 'node:test'

import type { NodeContextMenuContext } from '@/app/_authed/(extension-runtime)/_client/host'
import type { ResolvedNode } from '@/app/_authed/(extension-runtime)/_client/registry'
import type { ResolvedContext } from '@/app/_authed/(extension-runtime)/_types'
import { installDomEnvironment } from '@/test-support/dom-environment'

const dom = await installDomEnvironment()

const { act, createElement } = await import('react')
const { createRoot } = await import('react-dom/client')
const { NodeContextMenu } = await import('./node-context-menu')

after(() => dom.cleanup())

const engineInput: ResolvedContext = {
  sourceNodeId: 'engine-1',
  sourceHandleId: 'engine-out',
  type: 'acme.stack.engine',
  value: { host: 'tcp://10.0.0.7' },
}

interface Seen {
  isEnabled?: NodeContextMenuContext
  onSelect?: NodeContextMenuContext
}

// Mounts the menu the way a right-click does, with an item enabled only while
// its node's `engine-in` input is wired; returns the item's button.
async function openMenu(contexts: Record<string, ResolvedContext>, seen: Seen): Promise<HTMLButtonElement> {
  const resolvedNode = {
    contextMenuItems: [
      {
        id: 'start',
        label: 'Start',
        isEnabled: (ctx: NodeContextMenuContext) => {
          seen.isEnabled = ctx
          return Boolean(ctx.contexts['engine-in'])
        },
        onSelect: (ctx: NodeContextMenuContext) => {
          seen.onSelect = ctx
        },
      },
    ],
  } as unknown as ResolvedNode

  const root = createRoot(dom.container)
  after(() => act(() => root.unmount()))
  await act(async () => {
    root.render(
      createElement(NodeContextMenu, {
        position: { x: 0, y: 0 },
        node: { id: 'app-1', type: 'acme.stack.app', position: { x: 0, y: 0 }, data: {} },
        resolvedNode,
        contexts,
        onCopy: () => {},
        onDelete: () => {},
        onClose: () => root.unmount(),
      }),
    )
  })
  const button = Array.from(dom.container.querySelectorAll('button')).find((b) => b.textContent === 'Start')
  assert.ok(button, 'expected a "Start" item in the rendered menu')
  return button as HTMLButtonElement
}

test('an item on an unwired node is told no inputs and is offered disabled', async () => {
  const seen: Seen = {}
  const start = await openMenu({}, seen)

  assert.deepEqual(seen.isEnabled?.contexts, {})
  assert.equal(start.disabled, true)
})

test('an item on a wired node is told its inputs in isEnabled and onSelect, and is offered enabled', async () => {
  const seen: Seen = {}
  const start = await openMenu({ 'engine-in': engineInput }, seen)

  assert.deepEqual(seen.isEnabled?.contexts, { 'engine-in': engineInput })
  assert.equal(start.disabled, false)

  await act(async () => {
    start.click()
  })
  assert.equal(seen.onSelect?.nodeId, 'app-1')
  assert.deepEqual(seen.onSelect?.contexts, { 'engine-in': engineInput })
})

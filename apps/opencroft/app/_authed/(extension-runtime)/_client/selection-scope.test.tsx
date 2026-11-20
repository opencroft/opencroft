// The selection scope as a publisher meets it: items composed into the quote
// and the block with the names the mounting route gave, the deprecated pair
// passed through, a provider inside a scope publishing into it, and
// `usePublishSelection` publishing by value and clearing when it goes. A
// publisher clears on unmount only what it put there, so another surface's
// selection outlives it.
//
// No `SelectionSpace` here, so no channel: the cross-window rules are pinned in
// selection-broadcast-provider.test.tsx.

import assert from 'node:assert/strict'
import test, { after } from 'node:test'

import type { ReactNode } from 'react'

import type { Selection } from '@/app/_authed/(agent)/_shared/selection-envelope'
import { installDomEnvironment } from '@/test-support/dom-environment'

const dom = await installDomEnvironment()

const { act, StrictMode, useEffect } = await import('react')
const { createRoot } = await import('react-dom/client')
const { SelectionProvider, useOptionalSelection, usePublishSelection, useSelection } = await import(
  '@/app/_authed/(extension-runtime)/_client/selection-context'
)

after(() => dom.cleanup())

type Scope = ReturnType<typeof useSelection>

const TWO_NODES: Selection = {
  items: [
    { kind: 'node', graph: 'acme.default', id: 'n-1', name: 'api', type: 'script-node' },
    { kind: 'node', graph: 'acme.default', id: 'n-2', name: 'db', type: 'script-node' },
  ],
}

/** Records every value the scope shows, as a composer reading it would see it. */
function Reader({ seen }: { seen: Array<Scope['selection']> }) {
  const scope = useSelection()
  useEffect(() => {
    seen.push(scope.selection)
  }, [scope.selection, seen])
  return null
}

/** Hands the scope out, so a test can publish from outside React. */
function Grab({ into }: { into: { scope?: Scope } }) {
  into.scope = useSelection()
  return null
}

async function render(node: ReactNode) {
  const container = document.createElement('div')
  document.body.append(container)
  const root = createRoot(container)
  await act(async () => root.render(node))
  return {
    rerender: (next: ReactNode) => act(async () => root.render(next)),
    unmount: async () => {
      await act(async () => root.unmount())
      container.remove()
    },
  }
}

test('a published Selection is composed with the space and place the scope was mounted with', async () => {
  const seen: Array<Scope['selection']> = []
  const handle: { scope?: Scope } = {}
  const view = await render(
    <SelectionProvider spaceName='Acme' place='Default'>
      <Grab into={handle} />
      <Reader seen={seen} />
    </SelectionProvider>,
  )
  await act(async () => handle.scope?.setSelection(TWO_NODES))
  assert.equal(seen.at(-1)?.label, 'Acme › Default › 2 nodes selected')
  assert.match(seen.at(-1)?.content ?? '', /^Acme › Default › 2 nodes selected\nNode "api"/)
  await act(async () => handle.scope?.setSelection({ items: [] }))
  assert.equal(seen.at(-1), null, 'an empty list clears')
  await view.unmount()
})

test('a deprecated {label, content} pair is held as it was handed over', async () => {
  const seen: Array<Scope['selection']> = []
  const handle: { scope?: Scope } = {}
  const view = await render(
    <SelectionProvider spaceName='Acme' place='Docs'>
      <Grab into={handle} />
      <Reader seen={seen} />
    </SelectionProvider>,
  )
  const pair = { label: 'guide.md:12 · 3 lines', content: 'Documentation: acme.docs\nFile: guide.md' }
  await act(async () => handle.scope?.setSelection(pair))
  assert.deepEqual(seen.at(-1), pair)
  await view.unmount()
})

test('a provider inside a scope publishes into it, and clears what it published when it unmounts', async () => {
  const seen: Array<Scope['selection']> = []
  const inner: { scope?: Scope } = {}
  const tree = (withInner: boolean) => (
    <SelectionProvider spaceName='Acme' place='Docs'>
      {/* The composer sits outside the extension's own wrap. */}
      <Reader seen={seen} />
      {withInner ? (
        <SelectionProvider>
          <Grab into={inner} />
        </SelectionProvider>
      ) : null}
    </SelectionProvider>
  )
  const view = await render(tree(true))
  await act(async () => inner.scope?.setSelection(TWO_NODES))
  assert.equal(seen.at(-1)?.label, 'Acme › Docs › 2 nodes selected', 'the outer scope composed it')
  await view.rerender(tree(false))
  assert.equal(seen.at(-1), null, 'gone with the provider that published it')
  await view.unmount()
})

test('a provider inside a scope that never published leaves the scope alone when it unmounts', async () => {
  const seen: Array<Scope['selection']> = []
  const outer: { scope?: Scope } = {}
  const tree = (withInner: boolean) => (
    <SelectionProvider spaceName='Acme' place='Default'>
      <Grab into={outer} />
      <Reader seen={seen} />
      {withInner ? <SelectionProvider>{null}</SelectionProvider> : null}
    </SelectionProvider>
  )
  const view = await render(tree(true))
  await act(async () => outer.scope?.setSelection(TWO_NODES))
  await view.rerender(tree(false))
  assert.equal(seen.at(-1)?.label, 'Acme › Default › 2 nodes selected')
  await view.unmount()
})

/** Publishes `selection` through the hook. */
function Publisher({ selection }: { selection: Selection | null }) {
  usePublishSelection(selection)
  return null
}

test('a provider inside a scope whose last publish was an empty list leaves the scope alone when it unmounts', async () => {
  const seen: Array<Scope['selection']> = []
  const outer: { scope?: Scope } = {}
  const inner: { scope?: Scope } = {}
  const tree = (withInner: boolean) => (
    <SelectionProvider spaceName='Acme' place='Default'>
      <Grab into={outer} />
      <Reader seen={seen} />
      {withInner ? (
        <SelectionProvider>
          <Grab into={inner} />
        </SelectionProvider>
      ) : null}
    </SelectionProvider>
  )
  const view = await render(tree(true))
  await act(async () => inner.scope?.setSelection(TWO_NODES))
  await act(async () => inner.scope?.setSelection({ items: [] }))
  // Another surface in the same scope selects after the nested one emptied.
  await act(async () => outer.scope?.setSelection(TWO_NODES))
  await view.rerender(tree(false))
  assert.equal(seen.at(-1)?.label, 'Acme › Default › 2 nodes selected')
  await view.unmount()
})

test('a usePublishSelection publisher whose last value was empty leaves the scope alone when it unmounts', async () => {
  const seen: Array<Scope['selection']> = []
  const outer: { scope?: Scope } = {}
  const tree = (mounted: boolean) => (
    <SelectionProvider spaceName='Acme' place='Default'>
      <Grab into={outer} />
      <Reader seen={seen} />
      {mounted ? (
        <SelectionProvider>
          <Publisher selection={{ items: [] }} />
        </SelectionProvider>
      ) : null}
    </SelectionProvider>
  )
  const view = await render(tree(true))
  await act(async () => outer.scope?.setSelection(TWO_NODES))
  await view.rerender(tree(false))
  assert.equal(seen.at(-1)?.label, 'Acme › Default › 2 nodes selected')
  await view.unmount()
})

test('usePublishSelection publishes by value, replaces on change and clears on null and on unmount', async () => {
  const seen: Array<Scope['selection']> = []
  const tree = (selection: Selection | null, mounted = true) => (
    <SelectionProvider spaceName='Acme' place='Default'>
      <Reader seen={seen} />
      {mounted ? <Publisher selection={selection} /> : null}
    </SelectionProvider>
  )
  const view = await render(tree(TWO_NODES))
  assert.equal(seen.at(-1)?.label, 'Acme › Default › 2 nodes selected')
  const shown = seen.length

  // A fresh object of the same value is not a new selection.
  await view.rerender(tree(structuredClone(TWO_NODES)))
  assert.equal(seen.length, shown, 'an equal value publishes nothing')

  const one: Selection = { items: [TWO_NODES.items[0]] }
  await view.rerender(tree(one))
  assert.equal(seen.at(-1)?.label, 'Acme › Default › api')
  assert.equal(
    seen.slice(shown).some((value) => value === null),
    false,
    'a change replaces the selection without clearing it first',
  )

  await view.rerender(tree(null))
  assert.equal(seen.at(-1), null)

  await view.rerender(tree(TWO_NODES))
  await view.rerender(tree(TWO_NODES, false))
  assert.equal(seen.at(-1), null, 'the publisher going clears what it published')
  await view.unmount()
})

test('under StrictMode the selection survives the mount being run twice', async () => {
  const seen: Array<Scope['selection']> = []
  const view = await render(
    <StrictMode>
      <SelectionProvider spaceName='Acme' place='Default'>
        <Reader seen={seen} />
        <SelectionProvider>
          <Publisher selection={TWO_NODES} />
        </SelectionProvider>
      </SelectionProvider>
    </StrictMode>,
  )
  assert.equal(seen.at(-1)?.label, 'Acme › Default › 2 nodes selected')
  await view.unmount()
})

test('usePublishSelection outside a scope does nothing', async () => {
  let scope: ReturnType<typeof useOptionalSelection> = null
  function Probe() {
    scope = useOptionalSelection()
    usePublishSelection(TWO_NODES)
    return null
  }
  const view = await render(<Probe />)
  assert.equal(scope, null)
  await view.unmount()
})

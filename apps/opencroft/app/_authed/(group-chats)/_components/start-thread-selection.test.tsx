// The new-thread composer's half of the selection feature.
//
// This surface has no usage readout, so a control described by where it sits
// relative to one has no anchor of its own here. The composer answers that by
// forwarding the command bar's own slot rather than deciding a position a
// second time, and what is pinned below is the consequence: the control lands
// in the action row, BELOW the message rather than above it, which is the same
// relative spot it occupies on a composer that does have a readout.
//
// Why this surface needs the control at all is a fact about the scope, not
// about either composer: the pass flag is ONE flag per provider. A selection
// held back from a thread's composer is held back here too — so a surface that
// draws the quotation but offers no switch is a state a reader can reach and
// cannot leave. The last test is that state and its way out.
//
// The app's own host component is not mounted here: it reaches a server action
// on submit, and what it adds to this is a single forwarded prop. The composer
// it forwards into is the part with somewhere to go wrong.

import assert from 'node:assert/strict'
import test, { after } from 'node:test'

import type { ReactNode } from 'react'

import { installDomEnvironment } from '@/test-support/dom-environment'

const dom = await installDomEnvironment()

const { act, useEffect } = await import('react')
const { createRoot } = await import('react-dom/client')
const { SelectionProvider, useSelection } = await import('@/app/_authed/(extension-runtime)/_client/selection-context')
const { SelectionBadge } = await import('@/app/_authed/(extension-runtime)/_client/selection-badge')
const { SelectionToggle } = await import('@/app/_authed/(extension-runtime)/_client/selection-toggle')
const { StartThreadComposer } = await import('ui/group-chat/start-thread-composer')

after(() => dom.cleanup())

type Scope = ReturnType<typeof useSelection>

const LABEL = 'app-shell.tsx'
const CONTENT = 'Repository: myrepo\nFile: app/app-shell.tsx:42'
const AGENTS = [{ nodeId: 'agent-1', name: 'Ada' }]
// Node.DOCUMENT_POSITION_FOLLOWING, named here rather than read off a global
// this environment is not guaranteed to install.
const FOLLOWING = 0x04

let latest: Scope | null = null

function Probe(): ReactNode {
  const value = useSelection()
  useEffect(() => {
    latest = value
  })
  latest = value
  return null
}

// The composer as its host draws it: the quotation above, the composer below,
// and the toggle handed to the composer's forwarded slot rather than placed by
// the host. `controls` is what the "without the slot" case takes away.
function NewThreadSurface({ controls }: { controls: boolean }): ReactNode {
  return (
    <div data-surface='new-thread'>
      <SelectionBadge />
      <StartThreadComposer
        agents={AGENTS}
        selectedAgentNodeId='agent-1'
        onSelectAgent={() => {}}
        value=''
        onValueChange={() => {}}
        onSubmit={() => {}}
        attachmentControls={controls ? <SelectionToggle /> : undefined}
      />
    </div>
  )
}

interface View {
  scope: () => Scope
  select: () => Promise<void>
  quote: (surface: string) => Element | null
  toggle: (surface: string) => Element | null
  press: (surface: string) => Promise<void>
  unmount: () => Promise<void>
}

async function mount(tree: ReactNode): Promise<View> {
  latest = null
  const root = createRoot(dom.container)
  await act(async () => {
    root.render(
      <SelectionProvider>
        <Probe />
        {tree}
      </SelectionProvider>,
    )
  })
  const within = (surface: string) => {
    const scoped = dom.container.querySelector(`[data-surface='${surface}']`)
    assert.ok(scoped, `the ${surface} surface rendered`)
    return scoped
  }
  const toggle = (surface: string) => within(surface).querySelector('button[aria-pressed]')
  const scope = () => {
    assert.ok(latest, 'the scope rendered')
    return latest
  }
  return {
    scope,
    select: async () => {
      await act(async () => scope().setSelection({ label: LABEL, content: CONTENT }))
    },
    quote: (surface) => within(surface).querySelector('blockquote'),
    toggle,
    press: async (surface) => {
      const button = toggle(surface)
      assert.ok(button, `the ${surface} toggle is on screen to be pressed`)
      await act(async () => {
        ;(button as HTMLElement).click()
      })
    },
    unmount: async () => {
      await act(async () => root.unmount())
    },
  }
}

test('the forwarded control stands in the action row, below the message', async () => {
  const view = await mount(<NewThreadSurface controls />)
  await view.select()

  const button = view.toggle('new-thread')
  assert.ok(button, 'the toggle reached the composer')
  const textarea = dom.container.querySelector('textarea')
  assert.ok(textarea, 'the composer has a message field')
  // Document order is the claim: the lower part of the composer, not the row
  // above it, which is where the quotation goes and where this must not.
  assert.ok(
    (textarea.compareDocumentPosition(button) & FOLLOWING) !== 0,
    'the toggle follows the message field rather than preceding it',
  )
  await view.unmount()
})

test('without the slot the composer offers no toggle of its own', async () => {
  const view = await mount(<NewThreadSurface controls={false} />)
  await view.select()

  // The discriminating control for the test above: with a selection made and
  // the quotation drawn, the composer still produces no switch unless one is
  // handed to it. So the button found above came from the slot.
  assert.equal(view.quote('new-thread')?.textContent, LABEL, 'the selection is quoted either way')
  assert.equal(view.toggle('new-thread'), null, 'the composer invents no control')
  await view.unmount()
})

test('a selection held back from one composer can be brought back from the other', async () => {
  const view = await mount(
    <>
      <div data-surface='thread'>
        <SelectionBadge />
        <SelectionToggle />
      </div>
      <NewThreadSurface controls />
    </>,
  )
  await view.select()
  assert.ok(view.quote('thread'), 'both surfaces quote the selection to start with')
  assert.ok(view.quote('new-thread'))

  // One flag, two surfaces: holding it back anywhere holds it back everywhere.
  await view.press('thread')
  assert.equal(view.quote('thread'), null)
  assert.equal(view.quote('new-thread'), null, 'the new-thread composer follows the same flag')

  // ...which is why the way back has to exist on this surface too. Before the
  // slot was forwarded there was no control here to press.
  await view.press('new-thread')
  assert.equal(view.quote('new-thread')?.textContent, LABEL, 'the selection returns here')
  assert.equal(view.quote('thread')?.textContent, LABEL, 'and on the surface it was hidden from')
  await view.unmount()
})

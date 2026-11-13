// A section asked for again after its fetch failed: the hook is mounted, so
// expanding goes through the state it keeps between asks.
import assert from 'node:assert/strict'
import test, { after, mock } from 'node:test'

import type { ChatEvent } from 'agent-client/types'

import { installDomEnvironment } from '@/test-support/dom-environment'

const dom = await installDomEnvironment()

// After the DOM exists, never before -- react-dom binds to the globals it finds.
const { act, createElement } = await import('react')
const { createRoot } = await import('react-dom/client')
const { useSubagentSections } = await import('./use-subagent-sections')
type FetchSubagentPage = import('./use-subagent-sections').FetchSubagentPage

after(() => dom.cleanup())

const message = (text: string): ChatEvent => ({ kind: 'agent_message', text })

async function mount(fetchPage: FetchSubagentPage) {
  let current: ReturnType<typeof useSubagentSections> | undefined
  function Probe() {
    current = useSubagentSections(fetchPage)
    return null
  }
  const root = createRoot(dom.container)
  await act(async () => {
    root.render(createElement(Probe))
  })
  const hook = () => {
    assert.ok(current)
    return current
  }
  return { hook, unmount: () => act(async () => root.unmount()) }
}

test('a section whose fetch failed is fetched again when expanded again, keeping the frames it took', async () => {
  const quiet = mock.method(console, 'error', () => {})
  try {
    const asked: string[] = []
    let fail = true
    const { hook, unmount } = await mount(async (id) => {
      asked.push(id)
      if (fail) {
        fail = false
        throw new Error('offline')
      }
      return { startIndex: 0, hasMore: false, events: [message('first'), message('Hel')] }
    })

    await act(async () => hook().expand('child-1'))
    assert.deepEqual(asked, ['child-1'])
    assert.deepEqual(hook().sections.get('child-1'), {
      entries: new Map(),
      startIndex: null,
      hasMore: false,
      loading: false,
    })

    await act(async () => hook().applyStep({ subagentSessionId: 'child-1', position: 1, event: message('Hello') }))
    await act(async () => hook().expand('child-1'))
    assert.deepEqual(asked, ['child-1', 'child-1'])
    assert.deepEqual(hook().sections.get('child-1'), {
      entries: new Map([
        [1, message('Hello')],
        [0, message('first')],
      ]),
      startIndex: 0,
      hasMore: false,
      loading: false,
    })

    // Loaded, it is not fetched again.
    await act(async () => hook().expand('child-1'))
    assert.deepEqual(asked, ['child-1', 'child-1'])
    await unmount()
  } finally {
    quiet.mock.restore()
  }
})

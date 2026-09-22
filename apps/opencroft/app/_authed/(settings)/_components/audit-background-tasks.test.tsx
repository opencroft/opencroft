// The audit page's background tasks: what the list says before it is read,
// when it could not be read, when it holds nothing, and when it holds tasks --
// and how the page's poll turns a request that failed into the second of those.
//
// The page answers "can I restart now", so an empty list reads as "nothing is
// running". That makes every OTHER way of holding no rows a place a false
// all-clear can come from, and those are the rule pinned here. Rendered for
// real, because neither packages/ui nor the kit has a DOM to render the
// component in; this is the nearest place the kit's list and the page's read
// meet.

import assert from 'node:assert/strict'
import test, { after } from 'node:test'

import type { McpAuditBackgroundTask } from 'ui/settings/mcp-audit'

import { installDomEnvironment } from '@/test-support/dom-environment'

const dom = await installDomEnvironment()
// The page's filters are Radix selects, which build their closed-state portal
// target as a bare `new DocumentFragment()`; the environment does not put that
// constructor on the global object, and React reports its absence only as an
// empty AggregateError.
Object.assign(globalThis, { DocumentFragment: window.DocumentFragment })

const { act } = await import('react')
const { createRoot } = await import('react-dom/client')
const { McpAudit } = await import('ui/settings/mcp-audit')
const { readBackgroundTasks } = await import('@/app/_authed/(settings)/_lib/read-background-tasks')

after(() => dom.cleanup())

const MINUTE = 60_000

function task(
  overrides: Partial<McpAuditBackgroundTask> & Pick<McpAuditBackgroundTask, 'id' | 'state'>,
): McpAuditBackgroundTask {
  return {
    summary: `Task ${overrides.id}`,
    kind: 'tool',
    name: 'remote_script',
    target: 'buildbox/terminal',
    session: 'ada/1c9d',
    agent: 'ada',
    startedAt: Date.now() - 10 * MINUTE,
    ...overrides,
  }
}

// An element's text as a reader meets it: each piece of text on its own, one
// space apart. textContent runs neighbouring cells and lines together.
function words(el: Element): string {
  const pieces: string[] = []
  const walker = el.ownerDocument.createTreeWalker(el, window.NodeFilter.SHOW_TEXT)
  for (let node = walker.nextNode(); node; node = walker.nextNode()) {
    const text = node.textContent?.trim()
    if (text) {
      pieces.push(text)
    }
  }
  return pieces.join(' ')
}

interface Card {
  text: string
  /** Each task row's text, in the order drawn. */
  rows: string[]
  unmount: () => Promise<void>
}

async function renderCard(tasks: McpAuditBackgroundTask[] | null, error?: string | null): Promise<Card> {
  const root = createRoot(dom.container)
  await act(async () => {
    root.render(
      <McpAudit
        entries={[]}
        tools={[]}
        status='all'
        onToolChange={() => {}}
        onStatusChange={() => {}}
        onRefresh={() => {}}
        onClear={() => {}}
        loading={false}
        pending={false}
        sleepEnabled={false}
        onToggleSleep={() => {}}
        yoloEnabled={false}
        onToggleYolo={() => {}}
        sessions={[]}
        backgroundTasks={tasks}
        backgroundTasksError={error}
      />,
    )
  })
  const heading = Array.from(dom.container.querySelectorAll('div')).find((el) => el.textContent === 'Background tasks')
  const card = heading?.closest('.rounded-lg')
  assert.ok(card, 'the page draws a background-task card')
  return {
    text: words(card),
    rows: Array.from(card.querySelectorAll('tbody tr')).map(words),
    unmount: async () => {
      await act(async () => root.unmount())
    },
  }
}

const EMPTY = /nothing detached is running/
const COUNT = /\d+ running/

test('a list not read yet says it is reading, and nothing about what is running', async () => {
  const card = await renderCard(null)
  assert.match(card.text, /Reading background tasks/)
  assert.doesNotMatch(card.text, EMPTY)
  assert.doesNotMatch(card.text, COUNT, 'no count before there is anything to count')
  await card.unmount()
})

test('a list that could not be read says so and gives no count, even over rows it had', async () => {
  const card = await renderCard([task({ id: 'stale', state: 'running' })], 'the task registry did not answer')
  assert.match(card.text, /could not be read/)
  assert.match(card.text, /the task registry did not answer/)
  assert.doesNotMatch(card.text, EMPTY)
  assert.doesNotMatch(card.text, COUNT)
  assert.match(card.text, /unknown/)
  // Rows beside an error would be a list nobody can vouch for.
  assert.doesNotMatch(card.text, /Task stale/)
  await card.unmount()
})

test('only a list that was read and holds nothing says nothing is running', async () => {
  const card = await renderCard([])
  assert.match(card.text, EMPTY)
  assert.match(card.text, /0 running/)
  await card.unmount()
})

test('running tasks come first, in the order given, and are what the count counts', async () => {
  const now = Date.now()
  // Newest first, as the server hands them over: the oldest task is still running.
  const card = await renderCard([
    task({ id: 'done', state: 'completed', startedAt: now - 5 * MINUTE, finishedAt: now - 4 * MINUTE }),
    task({ id: 'new', state: 'running', startedAt: now - 10 * MINUTE }),
    task({ id: 'broke', state: 'failed', startedAt: now - 60 * MINUTE, finishedAt: now - 59 * MINUTE }),
    task({ id: 'old', state: 'running', startedAt: now - 300 * MINUTE }),
  ])
  assert.deepEqual(
    card.rows.map((row) => row.match(/^Task (\w+) /)?.[1]),
    ['new', 'old', 'done', 'broke'],
  )
  assert.match(card.text, /2 running/)
  await card.unmount()
})

test('a reason shows for a task that failed or was stopped, never for one that completed', async () => {
  const now = Date.now()
  const card = await renderCard([
    task({ id: 'a', state: 'completed', reason: 'said of a completion', finishedAt: now }),
    task({ id: 'b', state: 'failed', reason: 'exit status 2', finishedAt: now }),
    task({ id: 'c', state: 'stopped', reason: 'timed out after 60 min', finishedAt: now }),
  ])
  assert.doesNotMatch(card.text, /said of a completion/)
  assert.match(card.text, /exit status 2/)
  assert.match(card.text, /timed out after 60 min/)
  await card.unmount()
})

test('a sessionless caller reads as no session; time reads as so far, or as what it took', async () => {
  const now = Date.now()
  const card = await renderCard([
    task({ id: 'live', state: 'running', startedAt: now - 12 * MINUTE }),
    task({
      id: 'ended',
      state: 'completed',
      session: null,
      startedAt: now - 30 * MINUTE,
      finishedAt: now - 30 * MINUTE + 47_000,
    }),
  ])
  const [live, ended] = card.rows
  assert.match(live, /12m 0\ds so far/)
  assert.match(live, /ada\/1c9d/)
  assert.match(ended, /took 47s/)
  assert.match(ended, /no session/)
  await card.unmount()
})

test('a request that fails on the way reads as a list that could not be read', async () => {
  const list = await readBackgroundTasks(() => Promise.reject(new Error('Failed to fetch')))
  assert.deepEqual(list, { tasks: [], error: 'Failed to fetch' })
  assert.deepEqual(await readBackgroundTasks(() => Promise.reject('offline')), { tasks: [], error: 'offline' })

  // And the page draws it as one, not as the empty list its rows alone would make.
  const card = await renderCard(list.tasks, list.error)
  assert.match(card.text, /could not be read/)
  assert.doesNotMatch(card.text, EMPTY)
  await card.unmount()
})

test('a list the server returned, read or not, reaches the page as it came', async () => {
  const unreadable = { tasks: [], error: 'relation is missing' }
  assert.equal(await readBackgroundTasks(async () => unreadable), unreadable)
  const read = { tasks: [], error: null }
  assert.equal(await readBackgroundTasks(async () => read), read)
})

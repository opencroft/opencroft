// One screen, many chats: the chats page keeps the chat's screen mounted when
// the reader picks another chat (another space's) from its list, and only the
// route's parameter changes. The thread list must then draw that chat's own
// folders with that chat's threads in them, and a drag there must be saved to
// that chat at that chat's version.
//
// The hook is mounted with the real thread tree against a real DOM. Saving
// goes to the server, so Node's resolve hook hands the hook a fake for the save
// and passes every other export of the module through; the signed-in reader is
// faked the same way, because the folder open state is stored per person.
//
// WHAT THIS DOES NOT COVER: the route handing the screen the new chat's data,
// which TanStack's loader does, and the layout a reader sees, which only a
// browser shows.
import assert from 'node:assert/strict'
import { register } from 'node:module'
import test, { after, afterEach, beforeEach } from 'node:test'

import { installDomEnvironment } from '@/test-support/dom-environment'

const ACTIONS_URL = new URL('../_server/actions.ts', import.meta.url).href
register(
  `data:text/javascript,${encodeURIComponent(`
const fake = (real, names) =>
  'data:text/javascript,' +
  encodeURIComponent([
    'export * from ' + JSON.stringify(real + '?real'),
    ...names.map((name) => 'export const ' + name + ' = (...args) => globalThis.__serverFakes[' + JSON.stringify(name) + '](...args)'),
  ].join('\\n'))
export async function resolve(specifier, context, next) {
  const resolved = await next(specifier, context)
  if (resolved.url === ${JSON.stringify(ACTIONS_URL)}) {
    return { url: fake(resolved.url, ['saveGroupChatThreadLayout']), shortCircuit: true }
  }
  if (specifier === '@opencroft/auth/client') {
    return { url: fake(resolved.url, ['useSession']), shortCircuit: true }
  }
  return resolved
}`)}`,
)

const dom = await installDomEnvironment()

type SaveInput = { data: { groupChatId: string; list: string; layout: unknown; expectedVersion: number } }
type SaveResult = { ok: true; version: number } | { ok: false; current: unknown }

const saves: SaveInput['data'][] = []
// The answer the next save gets; a test that needs a save to stay in flight
// replaces it with one it settles itself.
let answerSave: (input: SaveInput) => Promise<SaveResult> = async () => ({ ok: true, version: 1000 })
;(globalThis as unknown as Record<string, unknown>).__serverFakes = {
  saveGroupChatThreadLayout: (input: SaveInput) => {
    saves.push(input.data)
    return answerSave(input)
  },
  useSession: () => ({ data: { user: { id: 'reader' } } }),
}

// After the DOM and the hook exist, never before.
const { act, createElement, Fragment, startTransition, use } = await import('react')
const { createRoot } = await import('react-dom/client')
const { useThreadLayout } = await import('./use-thread-layout')
const { GroupChatThreadTree } = await import('../_components/group-chat-thread-tree')

type Entry = Parameters<typeof GroupChatThreadTree>[0]['threads'][number]
type Loaded = Parameters<typeof useThreadLayout>[2]
type Persist = ReturnType<typeof useThreadLayout>['persist']

after(() => dom.cleanup())

function thread(groupChatId: string, id: string): Entry {
  return {
    id,
    groupChatId,
    title: id,
    agent: { nodeId: 'agent-1', name: 'Anna', avatarUrl: null },
    createdAt: new Date(0),
    sessionKey: `group-chat:${groupChatId}:anna:${id}`,
    agentIsMember: true,
    hasDraft: false,
    archived: false,
  }
}

interface Chat {
  id: string
  threads: Entry[]
  loaded: Loaded
}

// Two spaces' chats, each with folders of its own. The first one has been
// rearranged far more often, so its version is the higher one: the chat the
// reader moves to is behind the one they left.
const ALPHA: Chat = {
  id: 'chat-alpha',
  threads: [thread('chat-alpha', 'alpha-1'), thread('chat-alpha', 'alpha-2'), thread('chat-alpha', 'alpha-3')],
  loaded: {
    version: 12,
    layout: {
      entries: [
        { kind: 'folder', folder: { id: 'folder-alpha-work', name: 'Alpha work', threadIds: ['alpha-1'] } },
        { kind: 'folder', folder: { id: 'folder-alpha-later', name: 'Alpha later', threadIds: ['alpha-2'] } },
        { kind: 'thread', threadId: 'alpha-3' },
      ],
    },
  },
}
const BETA: Chat = {
  id: 'chat-beta',
  threads: [thread('chat-beta', 'beta-1'), thread('chat-beta', 'beta-2')],
  loaded: {
    version: 3,
    layout: {
      entries: [
        { kind: 'folder', folder: { id: 'folder-beta-review', name: 'Beta review', threadIds: ['beta-1'] } },
        { kind: 'thread', threadId: 'beta-2' },
      ],
    },
  },
}

// The last `persist` the mounted list was given, which is what a drag calls.
let persist: Persist | null = null

// A part of the next screen that is still loading. Rendered inside a
// transition, it keeps that render from committing, the way a route's pending
// data does while the previous screen stays up.
const neverLoads = new Promise<never>(() => {})
function StillLoading(): null {
  return use(neverLoads)
}

function Screen({ chat, loading = false }: { chat: Chat; loading?: boolean }) {
  const layout = useThreadLayout(chat.id, 'active', chat.loaded)
  if (!loading) {
    persist = layout.persist
  }
  return createElement(
    Fragment,
    null,
    createElement(GroupChatThreadTree, {
      threads: chat.threads,
      stateById: new Map(),
      layout: layout.layout,
      onChange: layout.persist,
      folderOpen: layout.folderOpen,
      onFolderOpenChange: layout.setFolderOpen,
      onSelect: () => {},
    }),
    loading ? createElement(StillLoading) : null,
  )
}

const root = createRoot(dom.container)
beforeEach(() => {
  saves.length = 0
  answerSave = async () => ({ ok: true, version: 1000 })
  window.localStorage.clear()
})
afterEach(async () => {
  await act(async () => root.render(null))
  persist = null
})

// The same element each time, so React keeps the mounted screen and hands it
// the next chat, the way the route does when only its parameter changes.
const show = (chat: Chat) => act(async () => root.render(createElement(Screen, { chat })))

// Each folder on screen with the threads drawn inside it, and the loose ones.
// Strings only: a failed assertion prints its values, and printing a jsdom
// element walks the whole document.
function drawn(): { folders: string[]; loose: string[] } {
  const folders = [...dom.container.querySelectorAll('[data-folder-header]')].map((header) => {
    const rows = [...(header.parentElement?.querySelectorAll('[data-row-list^="folder:"]') ?? [])]
    return `${header.textContent}: ${rows.map((row) => row.getAttribute('data-row-id')).join(', ')}`
  })
  const loose = [...dom.container.querySelectorAll('[data-row-list="items"]')].map(
    (row) => row.getAttribute('data-row-id') ?? '',
  )
  return { folders, loose }
}

const ALPHA_DRAWN = { folders: ['Alpha work: alpha-1', 'Alpha later: alpha-2'], loose: ['alpha-3'] }
const BETA_DRAWN = { folders: ['Beta review: beta-1'], loose: ['beta-2'] }

function currentPersist(): Persist {
  assert.ok(persist !== null, 'the list is mounted')
  return persist
}

test("switching between two chats, both ways and several times, draws only each chat's own folders", async () => {
  await show(ALPHA)
  assert.deepEqual(drawn(), ALPHA_DRAWN)
  for (let round = 0; round < 3; round++) {
    await show(BETA)
    assert.deepEqual(drawn(), BETA_DRAWN, `beta, round ${round + 1}`)
    await show(ALPHA)
    assert.deepEqual(drawn(), ALPHA_DRAWN, `alpha, round ${round + 1}`)
  }
})

test("a drag after switching is saved to the chat on screen, at that chat's version", async () => {
  await show(ALPHA)
  await show(BETA)
  const tree = [
    { type: 'item' as const, item: { id: 'beta-2', title: 'beta-2' } },
    { type: 'item' as const, item: { id: 'beta-1', title: 'beta-1' } },
  ]
  await act(async () => currentPersist()(tree))
  assert.deepEqual(
    saves.map((save) => [save.groupChatId, save.expectedVersion]),
    [['chat-beta', 3]],
  )
})

test('a switch that never commits leaves the chat on screen with its own arrangement and version', async () => {
  answerSave = async () => ({ ok: true, version: 13 })
  await show(ALPHA)
  const moved = [
    { type: 'item' as const, item: { id: 'alpha-3', title: 'alpha-3' } },
    ...ALPHA.threads.slice(0, 2).map((t) => ({ type: 'item' as const, item: { id: t.id, title: t.id } })),
  ]
  await act(async () => currentPersist()(moved))
  const alphaMoved = drawn()
  assert.notDeepEqual(alphaMoved, ALPHA_DRAWN, 'the drag changed what is drawn')

  // The reader picks beta; while beta is still loading, alpha's screen
  // re-renders on its own, and the router's loader still hands it alpha's
  // load-time layout.
  await act(async () => startTransition(() => root.render(createElement(Screen, { chat: BETA, loading: true }))))
  await show(ALPHA)

  assert.deepEqual(drawn(), alphaMoved, "alpha's drag stays on screen")
  await act(async () => currentPersist()(moved))
  assert.deepEqual(
    saves.map((save) => [save.groupChatId, save.expectedVersion]),
    [
      ['chat-alpha', 12],
      ['chat-alpha', 13],
    ],
    "alpha's next drag claims the version its last save was given",
  )
})

test('a save still in flight for the chat left behind neither draws in nor writes to the next one', async () => {
  // Alpha's save is refused once beta is on screen, with alpha's arrangement
  // as the one that won.
  let refuse: (result: SaveResult) => void = () => {}
  answerSave = () =>
    new Promise((resolve) => {
      refuse = resolve
    })
  await show(ALPHA)
  await act(async () =>
    currentPersist()([
      { type: 'item', item: { id: 'alpha-3', title: 'alpha-3' } },
      ...ALPHA.threads.slice(0, 2).map((t) => ({ type: 'item' as const, item: { id: t.id, title: t.id } })),
    ]),
  )
  await show(BETA)
  answerSave = async () => ({ ok: true, version: 4 })
  await act(async () => currentPersist()([{ type: 'item', item: { id: 'beta-2', title: 'beta-2' } }]))
  await act(async () => refuse({ ok: false, current: ALPHA.loaded }))

  assert.deepEqual(
    saves.map((save) => save.groupChatId),
    ['chat-alpha', 'chat-beta'],
    "beta's drag is its own save to beta, not queued behind alpha's",
  )
  assert.deepEqual(drawn().folders, [], "alpha's refused save does not put alpha's folders on beta's screen")
})

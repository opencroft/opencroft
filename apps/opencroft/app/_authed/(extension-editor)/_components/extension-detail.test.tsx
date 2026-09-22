// The execution badge on every action the extension page lists, and the road a
// manifest takes to reach it.
//
// Nothing between the manifest file and this page reads `execution`, which is
// the reason to check it end to end rather than on the component alone: the
// page shows whatever the loader and the server function hand it, and a step
// that copied known fields would drop a new one without a word. So the fixture
// starts as an extension.json on disk, is read by the plain implementation
// behind getLocalExtension, crosses the serialisation a server function's
// result crosses to the browser, and only then is rendered -- and each badge
// is read off the DOM.
import '@opencroft/db/test-env'

import assert from 'node:assert/strict'
import { promises as fs } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import test, { after } from 'node:test'

import { fromCrossJSON, toCrossJSONStream } from 'seroval'

import type { LocalExtensionRecord } from '@/app/_authed/(extension-editor)/_actions/local-extensions-actions'
import { installDomEnvironment } from '@/test-support/dom-environment'

const dom = await installDomEnvironment()

// Opening a group of actions reaches for three window methods by bare name, and
// all three exist on the jsdom window without being copied onto the global
// object: Radix's presence reads the content's computed style, and the
// collapsible measures its content in an animation frame and cancels that frame
// on unmount. Bridged and bound to the window, so this describes the real
// environment rather than standing in for a result.
const win = globalThis.window as unknown as Record<string, unknown>
const globals = globalThis as unknown as Record<string, unknown>
for (const name of ['getComputedStyle', 'requestAnimationFrame', 'cancelAnimationFrame']) {
  globals[name] = (win[name] as (...args: unknown[]) => unknown).bind(win)
}

const root = await fs.mkdtemp(path.join(os.tmpdir(), 'ext-execution-badge-'))
process.env.OPENCROFT_LOCAL_EXTENSIONS = root

// After the DOM exists, never before -- react-dom binds to the globals it finds.
const { act } = await import('react')
const { createRoot } = await import('react-dom/client')
const { defaultSerovalPlugins } = await import('@tanstack/router-core')
const { getLocalExtensionImpl } = await import(
  '@/app/_authed/(extension-editor)/_actions/local-extensions-actions-impl'
)
const { ExtensionDetail } = await import('@/app/_authed/(extension-editor)/_components/extension-detail')

after(async () => {
  dom.cleanup()
  await fs.rm(root, { recursive: true, force: true })
})

// Every mode on an app action, plus the two cases the page decides for itself:
// an action that declares nothing, and one that declares a mode that does not
// exist. Ids never repeat the app's slug or the node's type id, since the rows
// are found by the id they print.
const MANIFEST = {
  id: 'local/modes',
  name: 'Modes',
  version: '1.0.0',
  provides: {
    apps: [
      {
        slug: 'runner',
        title: 'Runner',
        actions: [
          { id: 'undeclared', label: 'Undeclared' },
          { id: 'declared-sync', label: 'Declared sync', execution: 'sync' },
          { id: 'per-call', label: 'Per call', execution: 'awaitable' },
          { id: 'detached', label: 'Detached', execution: 'async' },
          { id: 'misspelt', label: 'Misspelt', execution: 'asynk' },
        ],
      },
    ],
  },
  nodes: [
    {
      typeId: 'modes-node',
      name: 'Modes node',
      actions: [
        { id: 'node-undeclared', label: 'Node undeclared' },
        { id: 'node-detached', label: 'Node detached', execution: 'async' },
      ],
    },
  ],
}

await fs.mkdir(path.join(root, 'modes'), { recursive: true })
await fs.writeFile(path.join(root, 'modes', 'extension.json'), JSON.stringify(MANIFEST, null, 2))

// The record as the browser receives it. The server encodes a server
// function's result with seroval's toCrossJSONStream and Start's default
// plugins, sends it as a JSON body, and the client decodes it with
// fromCrossJSON and the same plugins (start-server-core's
// server-functions-handler, start-client-core's serverFnFetcher). The body is
// stringified and parsed here because it is text on the wire.
//
// Start's default plugins are the app's own serialization adapters followed by
// router-core's defaultSerovalPlugins. This app declares no adapters -- it has
// no createStart -- so router-core's list is the whole set; it is taken from
// there because getDefaultSerovalPlugins reads the adapters out of a request
// context that a test does not have.
async function wireRecord(): Promise<LocalExtensionRecord> {
  const record = await getLocalExtensionImpl('local/modes')
  assert.ok(record, 'the fixture extension must load')
  const plugins = defaultSerovalPlugins
  const body = await new Promise<unknown>((resolve, reject) => {
    let parsed: unknown
    toCrossJSONStream(record, {
      refs: new Map(),
      plugins,
      onParse: (node) => {
        parsed = node
      },
      onDone: () => resolve(parsed),
      onError: reject,
    })
  })
  return fromCrossJSON(JSON.parse(JSON.stringify(body)), { refs: new Map(), plugins }) as LocalExtensionRecord
}

async function mount(record: LocalExtensionRecord) {
  const reactRoot = createRoot(dom.container)
  await act(async () => {
    reactRoot.render(<ExtensionDetail record={record} onEdit={() => {}} onUpdate={() => {}} onDelete={() => {}} />)
  })
  return {
    unmount: async () => {
      await act(async () => {
        reactRoot.unmount()
      })
    },
  }
}

async function press(label: string, role: 'tab' | 'button') {
  const selector = role === 'tab' ? '[role="tab"]' : 'button'
  const target = [...dom.container.querySelectorAll<HTMLElement>(selector)].find((el) =>
    role === 'tab' ? el.textContent?.startsWith(label) : el.textContent === label,
  )
  assert.ok(target, `"${label}" must be on the page to be pressed`)
  await act(async () => {
    target.click()
  })
}

/** The badge in the row that prints `actionId`, or null when that row has none. */
function badgeFor(actionId: string): string | null {
  const id = [...dom.container.querySelectorAll('span.font-mono')].find((el) => el.textContent === actionId)
  assert.ok(id, `a row printing "${actionId}" must be on the page`)
  return id.parentElement?.querySelector('[data-slot="badge"]')?.textContent ?? null
}

test('execution survives the read from disk and the trip to the browser', async () => {
  const record = await wireRecord()
  const [app] = record.manifest.provides?.apps as Array<{ actions: Array<{ id: string; execution?: string }> }>
  assert.deepEqual(
    app.actions.map((action) => [action.id, action.execution]),
    [
      ['undeclared', undefined],
      ['declared-sync', 'sync'],
      ['per-call', 'awaitable'],
      ['detached', 'async'],
      ['misspelt', 'asynk'],
    ],
  )
  assert.deepEqual(
    record.manifest.nodes?.[0].actions?.map((action) => [action.id, action.execution]),
    [
      ['node-undeclared', undefined],
      ['node-detached', 'async'],
    ],
  )
})

test('every app action wears its mode; none declared reads Sync, an unknown one reads as written', async () => {
  const page = await mount(await wireRecord())
  try {
    await press('Apps', 'tab')
    await press('5 actions', 'button')
    assert.deepEqual(['undeclared', 'declared-sync', 'per-call', 'detached', 'misspelt'].map(badgeFor), [
      'Sync',
      'Sync',
      'Awaitable',
      'Async',
      'asynk',
    ])
  } finally {
    await page.unmount()
  }
})

test('a node action wears its mode the same way', async () => {
  const page = await mount(await wireRecord())
  try {
    await press('Nodes', 'tab')
    await press('2 actions', 'button')
    assert.deepEqual(['node-undeclared', 'node-detached'].map(badgeFor), ['Sync', 'Async'])
  } finally {
    await page.unmount()
  }
})

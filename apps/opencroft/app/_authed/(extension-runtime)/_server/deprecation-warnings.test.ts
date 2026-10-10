// A build that uses the deprecated extension API surface still succeeds, and
// says so: each use is a build warning naming the file, the line and where
// each name lives now, and the build logs them.
import assert from 'node:assert/strict'
import { promises as fs } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import test, { after, mock } from 'node:test'

import type { BuildResult, ExtensionManifest } from '@/app/_authed/(extension-runtime)/_types'
import { buildExtension } from './compiler'

const root = await fs.mkdtemp(path.join(os.tmpdir(), 'ext-deprecations-'))
const savedDataDir = process.env.OPENCROFT_DATA_DIR
process.env.OPENCROFT_DATA_DIR = root

after(async () => {
  if (savedDataDir === undefined) {
    delete process.env.OPENCROFT_DATA_DIR
  } else {
    process.env.OPENCROFT_DATA_DIR = savedDataDir
  }
  await fs.rm(root, { recursive: true, force: true })
})

async function build(slug: string, files: Record<string, string>): Promise<BuildResult> {
  const id = `local.${slug}`
  const dir = path.join(root, 'extensions', id)
  for (const [file, source] of Object.entries(files)) {
    await fs.mkdir(path.dirname(path.join(dir, file)), { recursive: true })
    await fs.writeFile(path.join(dir, file), source)
  }
  const manifest: ExtensionManifest = { id, name: slug, version: '0.0.0' }
  if (!('extension.json' in files)) {
    await fs.writeFile(path.join(dir, 'extension.json'), JSON.stringify(manifest))
  }
  return await buildExtension(id, manifest)
}

const messages = (result: BuildResult) =>
  result.warnings.map((warning) => `${warning.file}:${warning.line} ${warning.message}`)

test('a build on the modules reports no deprecation', async () => {
  // The control: without it, every assertion below would pass for a build
  // that warned about everything.
  const result = await build('modern', {
    'extension.json': JSON.stringify({
      name: 'modern',
      // Its own `text-stream`, which a pin names bare: not core's, so no warning.
      handleTypes: [
        { id: 'signal', label: 'Signal' },
        { id: 'text-stream', label: 'Own text' },
      ],
      nodes: [
        { type: 'n', name: 'N', handles: [{ id: 'in', handleType: 'builtin.core.text-stream', role: 'target' }] },
      ],
      provides: { apps: [{ type: 'board', title: 'Board' }] },
    }),
    'src/client.tsx': [
      "import { defineExtension } from '@opencroft/client/extension'",
      "import { InputHandle, NodeFrame, OutputHandle } from '@opencroft/client/canvas'",
      "import { toast } from 'sonner'",
      '',
      "export const pins = [<InputHandle type='builtin.core.text-stream' id='in' />, <OutputHandle type='text-stream' id='out' />]",
      "export const opened = { slug: 'my-board', params: {} }",
      "export default defineExtension({ manifest: { name: 'modern' }, handleTypes: [{ id: 'signal', label: 'Signal' }], nodes: [{ type: 'n', name: 'N', handles: [{ id: 'in', handleType: 'builtin.core.text-stream', role: 'target' }], component: () => { toast('x'); return NodeFrame } }], provides: { apps: [{ type: 'board', title: 'Board' }] } })",
      '',
    ].join('\n'),
    'server/index.ts':
      "import { graph } from '@opencroft/server/graph'\n\nexport const actions = { list: () => graph.listNodes() }\n",
  })
  assert.ok(result.success, JSON.stringify(result.errors))
  assert.deepEqual(messages(result), [])
})

test('each @ext/host and @ext/ui import is a warning naming where its names live now', async () => {
  const result = await build('old-client', {
    'src/client.tsx': [
      "import { defineExtension, icons, NodeFrame, type ResolvedContext } from '@ext/host'",
      "import { Button } from '@ext/ui'",
      '',
      'type Wired = ResolvedContext',
      "export default defineExtension({ manifest: { name: 'old' }, nodes: [{ type: 'n', name: 'N', component: () => [NodeFrame, Button, icons.Box] as unknown as Wired }] })",
      '',
    ].join('\n'),
  })
  assert.ok(result.success, 'a deprecated import still builds')
  assert.deepEqual(messages(result), [
    'src/client.tsx:1 `@ext/host` is deprecated: import `NodeFrame`, `ResolvedContext` from `@opencroft/client/canvas`; import `defineExtension` from `@opencroft/client/extension`; `icons`: use each icon by name from `lucide-react`',
    'src/client.tsx:2 `@ext/ui` is deprecated: import `Button` from `@opencroft/client/ui`',
  ])
})

test("a server module's default @ext/host import names the module of each member it reads", async () => {
  const result = await build('old-server', {
    'server/index.ts': [
      "import host from '@ext/host'",
      '',
      'export const actions = {',
      "  list: async () => [await host.graph.listNodes(), await host.storage.get('k'), host.db]",
      '}',
      '',
    ].join('\n'),
  })
  assert.ok(result.success, JSON.stringify(result.errors))
  assert.deepEqual(messages(result), [
    'server/index.ts:1 `@ext/host` is deprecated: import `graph` from `@opencroft/server/graph`; import `storage` from `@opencroft/server/storage`; `db`: not part of `@opencroft/server`',
  ])
})

test('the legacy namespace is a warning naming each name the file reads from it', async () => {
  const log = mock.method(console, 'warn', () => {})
  try {
    const result = await build('old-legacy', {
      'src/client.tsx': [
        "import { legacy } from '@opencroft/client'",
        '',
        'const { getStream } = legacy',
        "export const probe = () => legacy.toast.success(String(getStream('a', 'b')))",
        "export default legacy.defineExtension({ manifest: { name: 'l' }, nodes: [{ type: 'n', name: 'N', component: () => null }] })",
        '',
      ].join('\n'),
    })
    assert.ok(result.success, JSON.stringify(result.errors))
    assert.deepEqual(messages(result), [
      "src/client.tsx:1 `legacy` from `@opencroft/client` is deprecated: import `defineExtension` from `@opencroft/client/extension`; import `getStream` from `@opencroft/client/streams`; `toast`: use `import { toast } from 'sonner'`",
    ])
    // And the server log has it, once for the build, with the extension and the place.
    const logged = log.mock.calls
      .map((call) => String(call.arguments[0]))
      .filter((line) => line.includes('deprecated use'))
    assert.equal(logged.length, 1)
    assert.match(
      logged[0],
      /^\[ext\] local\.old-legacy: 1 deprecated use\(s\):\n {2}src\/client\.tsx:1 {2}`legacy` from/,
    )
  } finally {
    log.mock.restore()
  }
})

test('each deprecated key the manifest declares is a warning naming its path, line and replacement', async () => {
  const result = await build('old-manifest', {
    'extension.json': [
      '{',
      '  "name": "old-manifest",',
      '  "contexts": [{ "id": "signal", "label": "Signal" }],',
      '  "nodes": [',
      '    {',
      '      "typeId": "gauge",',
      '      "name": "Gauge",',
      '      "defaultData": { "typeId": "kept", "slug": "kept" },',
      '      "handles": [',
      '        { "id": "in", "contextType": "text-stream", "role": "target" },',
      '        { "id": "out", "contextType": "signal", "role": "source" }',
      '      ]',
      '    }',
      '  ],',
      '  "provides": { "apps": [{ "slug": "board", "title": "Board" }] }',
      '}',
    ].join('\n'),
  })
  assert.ok(result.success, JSON.stringify(result.errors))
  assert.deepEqual(messages(result), [
    'extension.json:3 `contexts` is deprecated: declare `handleTypes`',
    'extension.json:6 `nodes[0].typeId` is deprecated: declare `nodes[0].type`',
    'extension.json:10 `nodes[0].handles[0].contextType` is deprecated: declare `nodes[0].handles[0].handleType: "builtin.core.text-stream"` — under `handleType` a bare name is the extension\'s own',
    'extension.json:11 `nodes[0].handles[1].contextType` is deprecated: declare `nodes[0].handles[1].handleType`',
    'extension.json:15 `provides.apps[0].slug` is deprecated: declare `provides.apps[0].type`',
  ])
})

test('each deprecated key the client declaration uses, and each bare core handle pin, is a warning', async () => {
  const result = await build('old-declaration', {
    'src/client.tsx': [
      "import { defineExtension } from '@opencroft/client/extension'",
      "import { InputHandle, OutputHandle } from '@opencroft/client/canvas'",
      '',
      "const signalOut = { id: 'out', contextType: 'signal', role: 'source' as const }",
      "export const pins = [<InputHandle type='text-stream' id='in' />, <OutputHandle type='signal' id='out' />]",
      "export const opened = { slug: 'my-board' }",
      'export default defineExtension({',
      "  manifest: { name: 'old' },",
      "  contexts: [{ id: 'signal', label: 'Signal' }],",
      "  nodes: [{ typeId: 'gauge', name: 'Gauge', handles: [{ id: 'in', contextType: 'text-stream', role: 'target' }, signalOut], component: () => null }],",
      "  provides: { apps: [{ slug: 'board', title: 'Board', component: () => null }] },",
      '})',
      '',
    ].join('\n'),
  })
  assert.ok(result.success, JSON.stringify(result.errors))
  assert.deepEqual(messages(result).sort(), [
    'src/client.tsx:10 `contextType` is deprecated: declare `handleType: "builtin.core.text-stream"` — under `handleType` a bare name is the extension\'s own',
    "src/client.tsx:10 `typeId` is deprecated: declare the node's type under `type`",
    "src/client.tsx:11 `slug` is deprecated: declare the App's type under `type`",
    'src/client.tsx:4 `contextType` is deprecated: declare `handleType`',
    'src/client.tsx:5 `InputHandle type="text-stream"` is deprecated: name core\'s handle type qualified, `"builtin.core.text-stream"` — a bare name is read as core\'s only for compatibility',
    'src/client.tsx:9 `contexts` is deprecated: declare the handle types under `handleTypes`',
  ])
})

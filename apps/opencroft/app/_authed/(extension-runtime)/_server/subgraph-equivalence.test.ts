// A node behaves the same inside a subgraph as outside one: the same nodes,
// wired once directly and once by hand through a subgraph's ports, resolve the
// same contexts, carry the same streams, see the same connected sources and
// take the same exec dispatch. Runs the real registry, database and core
// bundle, as the other dispatch and stream tests here do.
import '@opencroft/db/test-env'

import assert from 'node:assert/strict'
import test from 'node:test'

import { SUBGRAPH_TYPE } from '@/app/_authed/(extension-runtime)/_builtin/core/src/nodes/subgraph-shared'
import { dispatchExecutionContext } from '@/app/_authed/(extension-runtime)/_server/exec-dispatch'
import { buildCtx, findNodeWithGraph } from '@/app/_authed/(extension-runtime)/_server/node-actions-impl'
import { broadcast, getStream } from '@/app/_authed/(extension-runtime)/_server/stream'
import { resolveGraph } from '@/app/_authed/(space)/_server/resolve-graph'
import { getSpacesRegistry } from '@/app/_authed/(space)/_server/store'
import type { GraphData } from '@/app/_authed/(space)/_server/types'

const HANDLER = 'function handler(event) { return { status: 200, body: { ok: true, type: event && event.type } }; }'

// An Event fires a script, a Localhost terminal is the script's `ctx-in`, a
// Prompt streams into a Log, and a second Prompt streams into a second Log.
// `p` prefixes every id: node ids are unique across spaces.
function nodes(p: string, inside: string | undefined): GraphData['nodes'] {
  const into = inside ? { parentId: inside } : {}
  return [
    { id: `${p}event`, type: 'builtin.core.event', position: { x: 0, y: 0 }, data: {} },
    { id: `${p}host`, type: 'builtin.core.localhost', position: { x: 0, y: 200 }, data: {} },
    { id: `${p}prompt`, type: 'builtin.core.prompt', position: { x: 0, y: 400 }, data: {} },
    { id: `${p}log-out`, type: 'builtin.core.log', position: { x: 800, y: 400 }, data: { max: 10, entries: [] } },
    {
      id: `${p}script`,
      type: 'builtin.core.script-node',
      position: { x: 300, y: 0 },
      data: { language: 'node', script: HANDLER },
      ...into,
    },
    { id: `${p}log`, type: 'builtin.core.log', position: { x: 300, y: 200 }, data: { max: 10, entries: [] }, ...into },
    { id: `${p}prompt-in`, type: 'builtin.core.prompt', position: { x: 300, y: 400 }, data: {}, ...into },
  ]
}

function edge(id: string, source: string, sourceHandle: string, target: string, targetHandle: string) {
  return { id, source, sourceHandle, target, targetHandle }
}

function direct(p: string): GraphData {
  return {
    nodes: nodes(p, undefined),
    edges: [
      edge(`${p}e1`, `${p}event`, 'exec-out', `${p}script`, 'exec-in'),
      edge(`${p}e2`, `${p}host`, 'terminal', `${p}script`, 'ctx-in'),
      edge(`${p}e3`, `${p}prompt`, 'text-out', `${p}log`, 'text-in'),
      edge(`${p}e4`, `${p}prompt-in`, 'text-out', `${p}log-out`, 'text-in'),
    ],
  }
}

function throughSubgraph(p: string): GraphData {
  const s = `${p}sub`
  const port = (id: string, handleType: string, multiple?: boolean) => ({
    id,
    label: id,
    handleType,
    ...(multiple ? { multiple } : {}),
  })
  return {
    nodes: [
      {
        id: s,
        type: SUBGRAPH_TYPE,
        position: { x: 200, y: 0 },
        data: {
          name: 'inner',
          ports: {
            inputs: [
              port('exec', 'builtin.core.execution-context', true),
              port('ctx', 'builtin.core.terminal-context'),
              port('text', 'builtin.core.text-stream', true),
            ],
            outputs: [port('said', 'builtin.core.text-stream')],
          },
        },
      },
      ...nodes(p, s),
    ],
    edges: [
      edge(`${p}o1`, `${p}event`, 'exec-out', s, 'in-exec'),
      edge(`${p}i1`, s, 'in-exec', `${p}script`, 'exec-in'),
      edge(`${p}o2`, `${p}host`, 'terminal', s, 'in-ctx'),
      edge(`${p}i2`, s, 'in-ctx', `${p}script`, 'ctx-in'),
      edge(`${p}o3`, `${p}prompt`, 'text-out', s, 'in-text'),
      edge(`${p}i3`, s, 'in-text', `${p}log`, 'text-in'),
      edge(`${p}i4`, `${p}prompt-in`, 'text-out', s, 'out-said'),
      edge(`${p}o4`, s, 'out-said', `${p}log-out`, 'text-in'),
    ],
  }
}

async function space(graph: GraphData): Promise<string> {
  const slug = `subgraph-equivalence-${crypto.randomUUID()}`
  const registry = getSpacesRegistry()
  await registry.ensureLoaded()
  await registry.create(slug, slug, await resolveGraph(graph))
  return slug
}

// `value` with the prefix of every id taken out, to compare the two graphs.
function unprefixed(value: unknown, p: string): unknown {
  return JSON.parse(JSON.stringify(value ?? null).replaceAll(p, ''))
}

function storedNode(id: string): Record<string, unknown> | undefined {
  const ref = getSpacesRegistry().findByNode(id)
  return ref?.graph.graph.nodes.find((n) => (n as { id?: string }).id === id)
}

async function waitFor(cond: () => boolean, label: string): Promise<void> {
  for (let i = 0; i < 500; i += 1) {
    if (cond()) {
      return
    }
    await new Promise((r) => setTimeout(r, 10))
  }
  throw new Error(`timed out waiting for: ${label}`)
}

const entriesOf = (id: string) =>
  ((storedNode(id)?.data as { entries?: Array<{ text: string }> } | undefined)?.entries ?? []).map((e) => e.text)

test('through a subgraph, nodes resolve, stream, connect and dispatch as when wired directly', async () => {
  const directSlug = await space(direct('d-'))
  const subgraphSlug = await space(throughSubgraph('s-'))

  // Contexts: the script's terminal and exec input, resolved on save.
  const contexts = (p: string) =>
    unprefixed((storedNode(`${p}script`)?.data as Record<string, unknown> | undefined)?.__resolvedContexts, p)
  assert.ok((contexts('d-') as Record<string, unknown> | null)?.['ctx-in'], 'the direct terminal resolves')
  assert.deepEqual(contexts('s-'), contexts('d-'))

  // Connected sources: the Log's text input names the real Prompt.
  const sources = async (p: string) => {
    const found = await findNodeWithGraph(`${p}log`)
    assert.ok(found)
    const ctx = buildCtx(found.graph, found.node, 'builtin.core', {}, found.slug, {}, undefined)
    return unprefixed(
      ctx.connectedSources('text-in').map((s) => [s.nodeId, s.handleId, s.type]),
      p,
    )
  }
  assert.deepEqual(await sources('d-'), [['prompt', 'text-out', 'builtin.core.prompt']])
  assert.deepEqual(await sources('s-'), await sources('d-'))

  // Exec dispatch: the Event fires the script, run in its terminal.
  const dispatch = async (p: string) =>
    dispatchExecutionContext({
      sourceNodeId: `${p}event`,
      sourceHandleId: 'exec-out',
      event: { type: 'event', nodeId: `${p}event`, firedAt: 0, payload: {} },
    })
  const directRun = await dispatch('d-')
  assert.equal(directRun.primary.error, undefined, `direct run failed: ${directRun.primary.error}`)
  assert.deepEqual((await dispatch('s-')).primary, directRun.primary)

  // Streams: into a Log through an input port, and out through an output port.
  for (const p of ['d-', 's-']) {
    const slug = p === 'd-' ? directSlug : subgraphSlug
    broadcast(getStream<{ text: string; final: boolean }>(slug, `${p}prompt`, 'text-out'), {
      text: 'into the log',
      final: true,
    })
    broadcast(getStream<{ text: string; final: boolean }>(slug, `${p}prompt-in`, 'text-out'), {
      text: 'out of the subgraph',
      final: true,
    })
    await waitFor(() => entriesOf(`${p}log`).length > 0 && entriesOf(`${p}log-out`).length > 0, `${p} logs`)
  }
  assert.deepEqual(entriesOf('s-log'), entriesOf('d-log'))
  assert.deepEqual(entriesOf('s-log-out'), entriesOf('d-log-out'))
  assert.deepEqual(entriesOf('d-log'), ['into the log'])
})

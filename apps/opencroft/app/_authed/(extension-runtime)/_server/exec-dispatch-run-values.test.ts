// What a producer was given reaches the value nodes while its run dispatches:
// an API Route's body, through a Get and a Math Expression, decides a
// Switch, at the top level and inside a subgraph fed through a port. Each run
// sees its own request, concurrent ones included, and none of it is stored.
// On the real database and the real builtin/core bundle, as the other
// dispatch tests here.
import '@opencroft/db/test-env'

import assert from 'node:assert/strict'
import test from 'node:test'

import { SUBGRAPH_TYPE } from '@/app/_authed/(extension-runtime)/_builtin/core/src/nodes/subgraph-shared'
import { getSpacesRegistry } from '@/app/_authed/(space)/_server/store'
import type { GraphData } from '@/app/_authed/(space)/_server/types'
import { dispatchExecutionContext } from './exec-dispatch'

const handler = (answer: string) => ({
  language: 'node',
  script: `function handler() { return { status: 200, body: ${JSON.stringify(answer)} }; }`,
})

type Edge = GraphData['edges'][number]
type Node = GraphData['nodes'][number]

function edge(id: string, from: string, to: string): Edge {
  const [source, sourceHandle] = from.split('/')
  const [target, targetHandle] = to.split('/')
  return { id, source, sourceHandle, target, targetHandle } as Edge
}

function node(id: string, bare: string, data: Record<string, unknown>, parentId?: string): Node {
  return { id, type: `builtin.core.${bare}`, position: { x: 0, y: 0 }, data, ...(parentId ? { parentId } : {}) } as Node
}

// API Route -> Get `user.age` (number) -> Math Expression `a >= 18` -> Switch,
// with a handler answering `adult` on True and `minor` on False. With
// `inside`, everything but the route sits in a subgraph whose input ports
// carry the run and the body.
function ageGraph(p: string, getData: Record<string, unknown>, inside: boolean): GraphData {
  const sub = `${p}sub`
  const into = inside ? sub : undefined
  const nodes = [
    node(`${p}route`, 'api-route', { path: `/${p}age`, methods: ['POST'] }),
    node(`${p}get`, 'get', { valueType: 'builtin.core.number', inputs: { path: 'user.age' }, ...getData }, into),
    node(`${p}math`, 'math-expression', { expression: 'a >= 18' }, into),
    node(`${p}sw`, 'switch', {}, into),
    ...['adult', 'minor'].map(
      (answer) =>
        ({
          id: `${p}${answer}`,
          type: 'script',
          position: { x: 0, y: 0 },
          data: handler(answer),
          ...(into ? { parentId: into } : {}),
        }) as Node,
    ),
  ]
  const inner = [
    edge(`${p}e3`, `${p}get/value`, `${p}math/var-a`),
    edge(`${p}e4`, `${p}math/result`, `${p}sw/condition`),
    edge(`${p}e5`, `${p}sw/exec-true`, `${p}adult/exec-in`),
    edge(`${p}e6`, `${p}sw/exec-false`, `${p}minor/exec-in`),
  ]
  if (!inside) {
    return {
      nodes,
      edges: [
        edge(`${p}e1`, `${p}route/exec-out`, `${p}sw/exec-in`),
        edge(`${p}e2`, `${p}route/body`, `${p}get/object`),
        ...inner,
      ],
    }
  }
  const port = (id: string, handleType: string) => ({ id, label: id, handleType })
  return {
    nodes: [
      {
        id: sub,
        type: SUBGRAPH_TYPE,
        position: { x: 0, y: 0 },
        data: {
          name: 'age',
          ports: {
            inputs: [port('run', 'builtin.core.execution-context'), port('body', 'builtin.core.object')],
            outputs: [],
          },
        },
      } as Node,
      ...nodes,
    ],
    edges: [
      edge(`${p}o1`, `${p}route/exec-out`, `${sub}/in-run`),
      edge(`${p}i1`, `${sub}/in-run`, `${p}sw/exec-in`),
      edge(`${p}o2`, `${p}route/body`, `${sub}/in-body`),
      edge(`${p}i2`, `${sub}/in-body`, `${p}get/object`),
      ...inner,
    ],
  }
}

async function space(name: string, build: (p: string) => GraphData): Promise<{ p: string; slug: string }> {
  const slug = `${name}-${crypto.randomUUID()}`
  const p = `${slug.slice(-8)}-`
  const registry = getSpacesRegistry()
  await registry.ensureLoaded()
  await registry.create(slug, slug, build(p) as never)
  return { p, slug }
}

// What the request is answered with: its status and body, or its error.
function post(p: string, body: unknown): Promise<{ status?: number; body?: unknown; error?: string }> {
  return dispatchExecutionContext({
    sourceNodeId: `${p}route`,
    sourceHandleId: 'exec-out',
    event: { method: 'POST', path: `/${p}age`, params: {}, query: {}, headers: {}, body },
  }).then(({ primary }) =>
    primary.error === undefined
      ? { status: primary.status, body: primary.body }
      : { status: primary.status, error: primary.error },
  )
}

for (const inside of [false, true]) {
  const where = inside ? 'inside a subgraph' : 'at the top level'

  test(`a request's body decides the Switch, ${where}`, async () => {
    const { p } = await space(`run-age-${inside ? 'sub' : 'top'}`, (prefix) => ageGraph(prefix, {}, inside))
    assert.deepEqual(await post(p, { user: { age: 30 } }), { status: 200, body: 'adult' })
    assert.deepEqual(await post(p, { user: { age: 10 } }), { status: 200, body: 'minor' })
  })

  test(`a body missing the field fails naming the Switch, and the fallback answers for it, ${where}`, async () => {
    const plain = await space('run-age-missing', (prefix) => ageGraph(prefix, {}, inside))
    const missing = await post(plain.p, {})
    assert.equal(missing.status, 500)
    assert.match(missing.error ?? '', /^Switch "Switch": condition has no value$/)

    const fallback = await space('run-age-fallback', (prefix) =>
      ageGraph(prefix, { inputs: { path: 'user.age', fallback: 0 } }, inside),
    )
    assert.deepEqual(await post(fallback.p, {}), { status: 200, body: 'minor' })
  })

  test(`a field of the wrong type is not the fallback, ${where}`, async () => {
    const { p } = await space('run-age-text', (prefix) =>
      ageGraph(prefix, { inputs: { path: 'user.age', fallback: 0 } }, inside),
    )
    const wrong = await post(p, { user: { age: '30' } })
    assert.equal(wrong.status, 500)
    assert.match(wrong.error ?? '', /condition has no value$/)
  })
}

test('concurrent requests each get the answer of their own body', async () => {
  const { p } = await space('run-age-concurrent', (prefix) => ageGraph(prefix, {}, false))
  const ages = Array.from({ length: 20 }, (_, i) => (i % 2 === 0 ? 30 : 10))
  const answers = await Promise.all(ages.map((age) => post(p, { user: { age } })))
  assert.deepEqual(
    answers.map((a) => a.body),
    ages.map((age) => (age >= 18 ? 'adult' : 'minor')),
  )
})

test('after the runs, the stored graph holds no value from any request', async () => {
  const { p, slug } = await space('run-age-stored', (prefix) => ageGraph(prefix, {}, false))
  await post(p, { user: { age: 30 } })
  const stored = [...(getSpacesRegistry().getBySlug(slug)?.graphs.values() ?? [])].flatMap((g) => g.graph.nodes)
  const text = JSON.stringify(stored)
  assert.ok(stored.length > 0, 'the space has its nodes')
  assert.ok(!text.includes('"age":30'), `a request's body is stored: ${text}`)
})

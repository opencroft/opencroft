// The calls that start background work, end to end through handleToolCall:
// every kind of tool the registry dispatches — a static one, an extension's, an
// agent-tool node — declared `awaitable` or `async` over a handler that knows
// nothing of it; remote_exec and remote_script on their runner adapters; and
// `call`/`app_call` on actions whose manifest says how callers wait. What is
// asserted is what reaches the service, what a handler is handed when its task
// runs it, and that the approval gate still stands in front of all of it.
//
// A local extension written into a scratch root stands in for the extensions
// that really declare such tools and actions, which live in other
// repositories. Its server module is written as a build would leave it, so
// nothing compiles. It also gives the remote tools a target,
// `extensions/<slug>`, that resolves without a node. The service is a
// stand-in: nothing here starts a process, and a task's work runs only when a
// test runs it — which is how "the handler runs afterwards" is observed.
//
// Exercises the real database (embedded PGlite) — see @opencroft/db's test-env.
import '@opencroft/db/test-env'

import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test, { after, afterEach } from 'node:test'

import type { ExecutionMode } from '@opencroft/core'
import { db, spaceApp } from '@opencroft/db'

import { withApprovalRequired } from '@/app/_authed/(approvals)/_server/with-approval'
import type {
  BackgroundTaskRecord,
  BackgroundTaskService,
  StartInProcessTaskInput,
  StartRunnerTaskInput,
} from '@/app/_authed/(background-tasks)/_server/types'
import { getSpacesRegistry } from '@/app/_authed/(space)/_server/store'
import { approvalStore } from '@/lib/approval-store'
import { ASYNC_SENTENCE, AWAITABLE_SENTENCE, type ListedTool } from './execution-mode'
import type { ToolCallerContext, ToolHandler } from './tool-caller'
import { handleToolCall, listDynamicTools, registerToolForTests } from './tools'
import { setYoloMode } from './yolo'

// After the barrel, and lazily: see task-tools.test.ts.
const { substituteBackgroundTaskService } = await import('./task-tools')

const suffix = crypto.randomUUID().slice(0, 8)

// ── the fixture extension ────────────────────────────────────────────

const root = mkdtempSync(join(tmpdir(), 'background-calls-'))
process.env.OPENCROFT_LOCAL_EXTENSIONS = root
after(() => rmSync(root, { recursive: true, force: true }))

const SLUG = `bgfix-${suffix}`
const TARGET = `extensions/${SLUG}`
const SCHEMA = { type: 'object', properties: { region: { type: 'string' } } }
const ACTIONS = [
  { id: 'deploy', label: 'Deploy', description: 'Deploy it.', execution: 'async' },
  { id: 'build', label: 'Build', inputSchema: SCHEMA, execution: 'awaitable' },
  { id: 'status', label: 'Status', inputSchema: SCHEMA },
]
// The extension's tools, one per way of waiting, and one whose mode is misspelt.
const EXT = {
  async: `bgfix_${suffix}_ext_async`,
  awaitable: `bgfix_${suffix}_ext_awaitable`,
  sync: `bgfix_${suffix}_ext_sync`,
  misspelt: `bgfix_${suffix}_ext_misspelt`,
}
// The node type an agent-tool node hands its calls to.
const HANDLER_TYPE = `${SLUG}-handler`
mkdirSync(join(root, SLUG, 'dist'), { recursive: true })
writeFileSync(
  join(root, SLUG, 'extension.json'),
  JSON.stringify({
    id: `local/${SLUG}`,
    name: 'Background-call fixture',
    version: '0.0.0',
    nodes: [
      { typeId: `${SLUG}-node`, name: 'Fixture node', actions: ACTIONS },
      { typeId: HANDLER_TYPE, name: 'Fixture handler' },
    ],
    provides: {
      apps: [{ slug: `${SLUG}-app`, title: 'Fixture app', actions: ACTIONS }],
      mcpTools: [
        { name: EXT.async, description: 'Index the repository.', inputSchema: SCHEMA, execution: 'async' },
        { name: EXT.awaitable, description: 'Build it.', inputSchema: SCHEMA, execution: 'awaitable' },
        { name: EXT.sync, description: 'Look at it.', inputSchema: SCHEMA },
        { name: EXT.misspelt, description: 'Misspelt.', inputSchema: SCHEMA, execution: 'asynch' },
      ],
    },
  }),
)
// Plain handlers, as an extension author writes them: none knows how it is
// waited for. With no source entry to compile, the loader evaluates this
// bundle as it stands.
writeFileSync(
  join(root, SLUG, 'dist', 'server.js'),
  `module.exports = {
  tools: {
    ${JSON.stringify(EXT.async)}: async (args) => ({ indexed: args }),
    ${JSON.stringify(EXT.awaitable)}: async (args) => 'built ' + JSON.stringify(args),
    ${JSON.stringify(EXT.sync)}: async (args) => 'looked at ' + JSON.stringify(args),
    ${JSON.stringify(EXT.misspelt)}: async (args) => 'ran in place with ' + JSON.stringify(args),
  },
  nodeActions: {
    ${JSON.stringify(HANDLER_TYPE)}: {
      handle: async (ctx) => ({ body: { handled: ctx.params.params, tool: ctx.params.context.toolName } }),
    },
  },
}
`,
)

// ── the fixture space ────────────────────────────────────────────────

const registry = getSpacesRegistry()
await registry.ensureLoaded()
const spaceSlug = `background-calls-${suffix}`
const NODE_ID = `bgfix-node-${suffix}`
const HANDLER_NODE = `bgfix-handler-${suffix}`
const GRAPH_SCHEMA = JSON.stringify({ type: 'object', properties: { q: { type: 'string' } } })

// Agent-tool nodes: all but the unwired ones hand their calls to the fixture handler.
const GRAPH = {
  async: { name: `bgfix_${suffix}_graph_async`, execution: 'async', requireApproval: false, wired: true },
  awaitable: { name: `bgfix_${suffix}_graph_awaitable`, execution: 'awaitable', requireApproval: false, wired: true },
  sync: { name: `bgfix_${suffix}_graph_sync`, execution: undefined, requireApproval: false, wired: true },
  gated: { name: `bgfix_${suffix}_graph_gated`, execution: 'async', requireApproval: true, wired: true },
  unwired: { name: `bgfix_${suffix}_graph_unwired`, execution: undefined, requireApproval: false, wired: false },
  unwiredAsync: {
    name: `bgfix_${suffix}_graph_unwired_async`,
    execution: 'async',
    requireApproval: false,
    wired: false,
  },
}
const graphTools = Object.values(GRAPH).map((tool) => ({ ...tool, id: `node-${tool.name}` }))

const space = await registry.create(spaceSlug, spaceSlug, {
  nodes: [
    { id: NODE_ID, type: `${SLUG}-node`, position: { x: 0, y: 0 }, data: {} },
    { id: HANDLER_NODE, type: HANDLER_TYPE, position: { x: 400, y: 0 }, data: {} },
    ...graphTools.map((tool) => ({
      id: tool.id,
      type: 'agent-tool',
      position: { x: 0, y: 200 },
      data: {
        name: tool.name,
        description: `Graph tool ${tool.name}.`,
        inputSchema: GRAPH_SCHEMA,
        requireApproval: tool.requireApproval,
        ...(tool.execution ? { execution: tool.execution } : {}),
      },
    })),
  ],
  edges: graphTools
    .filter((tool) => tool.wired)
    .map((tool) => ({
      id: `edge-${tool.id}`,
      source: tool.id,
      sourceHandle: 'exec-out',
      target: HANDLER_NODE,
      targetHandle: 'exec-in',
    })),
})
const [appRow] = await db
  .insert(spaceApp)
  .values({ spaceId: space.id, extensionId: `local/${SLUG}`, appSlug: `${SLUG}-app`, name: 'Fixture', slug: 'fixture' })
  .returning()
const APP_ADDRESS = `${spaceSlug}.fixture`

// ── the stand-in service ─────────────────────────────────────────────

function fakeService() {
  const runnerTasks: StartRunnerTaskInput[] = []
  const inProcess: StartInProcessTaskInput[] = []
  const started = (
    input: Pick<StartRunnerTaskInput, 'owner' | 'name' | 'target' | 'summary' | 'timeoutMs'>,
    kind: BackgroundTaskRecord['kind'],
    runner: BackgroundTaskRecord['runner'],
  ): BackgroundTaskRecord => ({
    taskId: `task-${runnerTasks.length + inProcess.length}`,
    agent: input.owner.agent,
    kind,
    runner,
    name: input.name,
    target: input.target,
    summary: input.summary,
    state: 'running',
    startedAt: new Date(),
    timeoutMs: input.timeoutMs,
  })
  const unexpected = async (): Promise<never> => {
    throw new Error('not expected in this test')
  }
  const service: BackgroundTaskService = {
    startRunnerTask: async (input) => {
      runnerTasks.push(input)
      return started(input, 'tool', 'background-task-runner')
    },
    startInProcessTask: async (input) => {
      inProcess.push(input)
      return started(input, input.kind, 'in-process')
    },
    get: unexpected,
    listForOwner: unexpected,
    listRunning: unexpected,
    cancel: unexpected,
    runningSessionKeys: () => new Set(),
    subscribeRunningSessionKeys: () => () => {},
  }
  substituteBackgroundTaskService(service)
  return { runnerTasks, inProcess }
}

const unregister: (() => void)[] = []

afterEach(() => {
  substituteBackgroundTaskService(undefined)
  for (const off of unregister.splice(0)) {
    off()
  }
})

function text(result: Record<string, unknown>): string {
  return (result.content as { text: string }[])[0]?.text ?? ''
}

function failsWith(pattern: RegExp, code?: number) {
  return (err: { code?: number; message?: string }) => {
    assert.match(err.message ?? '', pattern)
    if (code !== undefined) {
      assert.equal(err.code, code)
    }
    return true
  }
}

async function pendingApproval(tool: string) {
  for (let i = 0; i < 400; i++) {
    const request = approvalStore.list().find((r) => r.tool === tool)
    if (request) {
      return request
    }
    await new Promise((resolve) => setTimeout(resolve, 5))
  }
  throw new Error(`no approval was requested for ${tool}`)
}

function signal(): AbortSignal {
  return new AbortController().signal
}

// ── a static tool: a declaration, and an ordinary handler ────────────

/** A handler as any tool family writes one: its arguments in, its answer out. */
function plainHandler() {
  const calls: { args: Record<string, unknown>; caller: ToolCallerContext }[] = []
  const handler: ToolHandler = async (args, caller) => {
    calls.push({ args, caller })
    return { content: [{ type: 'text', text: `indexed with ${JSON.stringify(args)}` }] }
  }
  return { calls, handler }
}

/** Register a static tool for this test only; its name, which the registry now dispatches. */
function staticTool(execution: ExecutionMode | undefined, handler: ToolHandler): string {
  const name = `fixture_${crypto.randomUUID().slice(0, 8)}`
  unregister.push(registerToolForTests({ name, ...(execution ? { execution } : {}) }, handler))
  return name
}

test('a static tool declared awaitable, called with background: true, answers with its task at once, and its plain handler is the task', async () => {
  const { inProcess } = fakeService()
  const { calls, handler } = plainHandler()
  const name = staticTool('awaitable', handler)
  const result = await handleToolCall(
    name,
    { nodeId: 'node-7', depth: 2, description: 'Index the graph', background: true, timeoutMinutes: 5 },
    { internal: true, callerAgent: 'Background Agent', callerSessionId: 'session-10' },
  )
  assert.equal(
    text(result),
    'Started background task task-1 — Index the graph. Its result will arrive in this conversation when it ends.',
  )
  assert.equal(calls.length, 0, 'the call did not wait for the handler')
  const [start] = inProcess
  assert.ok(start)
  assert.deepEqual(
    {
      owner: start.owner,
      kind: start.kind,
      name: start.name,
      target: start.target,
      summary: start.summary,
      timeoutMs: start.timeoutMs,
    },
    {
      owner: { agent: 'Background Agent', sessionId: 'session-10' },
      kind: 'tool',
      name,
      target: 'node-7',
      summary: 'Index the graph',
      timeoutMs: 300_000,
    },
  )

  const controller = new AbortController()
  assert.equal(
    await start.run(controller.signal),
    'indexed with {"nodeId":"node-7","depth":2,"description":"Index the graph"}',
    'its own answer, verbatim, is the result',
  )
  assert.deepEqual(calls[0]?.args, { nodeId: 'node-7', depth: 2, description: 'Index the graph' }, 'minus the two')
  assert.equal(calls[0]?.caller.signal, controller.signal, 'the task’s signal, for the handler to watch or ignore')
  assert.equal(calls[0]?.caller.agent, 'Background Agent')
  assert.equal(calls[0]?.caller.sessionId, 'session-10')
})

test('the same tool without background: true — absent, false, or not a boolean — runs in place, and never sees the two', async () => {
  const { inProcess } = fakeService()
  const { calls, handler } = plainHandler()
  const name = staticTool('awaitable', handler)
  for (const flag of [{}, { background: false }, { background: 'true' }]) {
    const result = await handleToolCall(name, { depth: 1, timeoutMinutes: 5, ...flag }, { internal: true })
    assert.equal(text(result), 'indexed with {"depth":1}')
  }
  assert.equal(inProcess.length, 0)
  assert.equal(calls.length, 3)
  assert.ok(
    calls.every((call) => call.caller.signal === undefined),
    'a call run in place carries no signal',
  )
})

test('a static tool declared async always runs as a task, under the default limit, its arguments all its own', async () => {
  const { inProcess } = fakeService()
  const { calls, handler } = plainHandler()
  const name = staticTool('async', handler)
  const result = await handleToolCall(name, { background: false, timeoutMinutes: 1 }, { internal: true })
  assert.match(text(result), /^Started background task task-1 — /)
  const [start] = inProcess
  assert.equal(start?.timeoutMs, 3_600_000, 'its schema offered no timeout, so none was read')
  assert.equal(start?.target, '', 'its arguments named nothing to run against')
  assert.equal(start?.summary, name, 'with no description, a tool task is known by the tool')
  await start?.run(signal())
  assert.deepEqual(calls[0]?.args, { background: false, timeoutMinutes: 1 })
})

test('a static tool declared sync, or not at all, runs in place as it always has, its arguments untouched', async () => {
  const { inProcess } = fakeService()
  const { calls, handler } = plainHandler()
  for (const execution of ['sync', undefined] as const) {
    const result = await handleToolCall(
      staticTool(execution, handler),
      { background: true, timeoutMinutes: 5 },
      { internal: true },
    )
    assert.equal(text(result), 'indexed with {"background":true,"timeoutMinutes":5}')
  }
  assert.equal(inProcess.length, 0)
  assert.equal(calls.length, 2)
})

test('a task fails with what its call would have failed with: an isError answer’s text, or what was thrown', async () => {
  const { inProcess } = fakeService()
  const refusing = staticTool('async', async () => ({
    content: [{ type: 'text', text: 'the index is locked' }],
    isError: true,
  }))
  const throwing = staticTool('async', async () => {
    throw { code: -32000, message: 'the graph is gone' }
  })
  await handleToolCall(refusing, {}, { internal: true })
  await handleToolCall(throwing, {}, { internal: true })
  const [refused, thrown] = inProcess
  assert.ok(refused && thrown)
  await assert.rejects(
    refused.run(signal()),
    (err: Error) => err instanceof Error && err.message === 'the index is locked',
  )
  await assert.rejects(thrown.run(signal()), failsWith(/^the graph is gone$/, -32000))
})

test('a malformed timeoutMinutes is refused before the handler runs or anything starts', async () => {
  const { inProcess } = fakeService()
  const { calls, handler } = plainHandler()
  const name = staticTool('awaitable', handler)
  for (const timeoutMinutes of [-1, '30']) {
    await assert.rejects(
      handleToolCall(name, { background: true, timeoutMinutes }, { internal: true }),
      failsWith(/timeoutMinutes must be a number/, -32602),
    )
  }
  assert.equal(inProcess.length, 0)
  assert.equal(calls.length, 0)
})

test('a caller with no session is told no notification will come, and to poll task_status by id', async () => {
  fakeService()
  const name = staticTool('async', plainHandler().handler)
  const result = await handleToolCall(name, { description: 'Index the graph' }, { internal: true })
  assert.equal(
    text(result),
    'Started background task task-1 — Index the graph. No notification will arrive: this caller has no session. ' +
      'Poll task_status with taskId "task-1" for its state and output.',
  )
})

test('a static tool that asks for approval asks before it runs in the background; a rejected call starts nothing', async () => {
  const { inProcess } = fakeService()
  setYoloMode(false)
  approvalStore.setAutoApprove(false)
  const { calls, handler } = plainHandler()
  const name = staticTool('async', withApprovalRequired(handler))

  const rejected = handleToolCall(name, { description: 'Index' }, { internal: false, callerSessionId: 'session-14' })
  const first = await pendingApproval(name)
  assert.equal(inProcess.length, 0, 'nothing starts while the approval is pending')
  approvalStore.reject(first.id, 'not now')
  const refusal = await rejected
  assert.equal(refusal.isError, true)
  assert.match(text(refusal), /not now/)
  assert.equal(inProcess.length, 0, 'and nothing starts after a rejection')

  const approved = handleToolCall(name, { description: 'Index' }, { internal: false, callerSessionId: 'session-14' })
  approvalStore.approve((await pendingApproval(name)).id)
  assert.match(text(await approved), /^Started background task/)
  assert.equal(inProcess.length, 1)
  assert.equal(calls.length, 0, 'approved, it starts — and runs when its task does')
})

// ── an extension's tools ─────────────────────────────────────────────

test('an extension tool whose manifest entry says async detaches, and what its handler returns is the result', async () => {
  const { inProcess } = fakeService()
  const result = await handleToolCall(EXT.async, { region: 'eu' }, { internal: true, callerSessionId: 'session-20' })
  assert.equal(
    text(result),
    `Started background task task-1 — ${EXT.async}. Its result will arrive in this conversation when it ends.`,
  )
  const [start] = inProcess
  assert.deepEqual([start?.kind, start?.name, start?.target, start?.timeoutMs], ['tool', EXT.async, '', 3_600_000])
  assert.equal(await start?.run(signal()), '{"indexed":{"region":"eu"}}')
})

test('an awaitable extension tool detaches with background: true and runs in place without; its handler never sees the two', async () => {
  const { inProcess } = fakeService()
  const inPlace = await handleToolCall(EXT.awaitable, { region: 'eu', timeoutMinutes: 3 }, { internal: true })
  assert.equal(text(inPlace), 'built {"region":"eu"}')
  assert.equal(inProcess.length, 0)

  await handleToolCall(EXT.awaitable, { region: 'us', background: true, timeoutMinutes: 3 }, { internal: true })
  assert.equal(inProcess[0]?.timeoutMs, 180_000)
  assert.equal(await inProcess[0]?.run(signal()), 'built {"region":"us"}')
})

test('an extension tool with no mode, or a misspelt one, runs in place with its arguments as sent', async () => {
  const { inProcess } = fakeService()
  const sync = await handleToolCall(EXT.sync, { region: 'eu', background: true }, { internal: true })
  assert.equal(text(sync), 'looked at {"region":"eu","background":true}')
  const misspelt = await handleToolCall(EXT.misspelt, { background: true }, { internal: true })
  assert.equal(text(misspelt), 'ran in place with {"background":true}')
  assert.equal(inProcess.length, 0)
})

// ── agent-tool nodes ─────────────────────────────────────────────────

test('an agent-tool node with execution async detaches, and its connected handler is the task', async () => {
  const { inProcess } = fakeService()
  const result = await handleToolCall(GRAPH.async.name, { q: 'x' }, { internal: true, callerSessionId: 'session-30' })
  assert.match(text(result), new RegExp(`^Started background task task-1 — ${GRAPH.async.name}\\. Its result will`))
  const [start] = inProcess
  assert.deepEqual([start?.kind, start?.name, start?.timeoutMs], ['tool', GRAPH.async.name, 3_600_000])
  assert.equal(await start?.run(signal()), JSON.stringify({ handled: { q: 'x' }, tool: GRAPH.async.name }))
})

test('an awaitable agent-tool node runs in place unless asked, and its handler gets only its own arguments', async () => {
  const { inProcess } = fakeService()
  const inPlace = await handleToolCall(GRAPH.awaitable.name, { q: 'here', timeoutMinutes: 2 }, { internal: true })
  assert.equal(text(inPlace), JSON.stringify({ handled: { q: 'here' }, tool: GRAPH.awaitable.name }))
  await handleToolCall(GRAPH.awaitable.name, { q: 'later', background: true }, { internal: true })
  assert.equal(
    await inProcess[0]?.run(signal()),
    JSON.stringify({ handled: { q: 'later' }, tool: GRAPH.awaitable.name }),
  )
})

test('an agent-tool node that asks for approval asks before its task starts, in the space it is drawn in', async () => {
  const { inProcess } = fakeService()
  setYoloMode(false)
  approvalStore.setAutoApprove(false)
  const call = handleToolCall(GRAPH.gated.name, { q: 'y' }, { internal: false, callerSessionId: 'session-31' })
  const request = await pendingApproval(GRAPH.gated.name)
  assert.equal(request.spaceId, spaceSlug)
  assert.equal(inProcess.length, 0, 'nothing starts while the approval is pending')
  approvalStore.approve(request.id)
  assert.match(text(await call), /^Started background task/)
  assert.equal(inProcess.length, 1)
})

test('an agent-tool node that fails fails its call or its task — never answers with the error as a result', async () => {
  const { inProcess } = fakeService()
  await assert.rejects(
    handleToolCall(GRAPH.unwired.name, {}, { internal: true }),
    failsWith(/has no connected handler script/),
  )
  await handleToolCall(GRAPH.unwiredAsync.name, {}, { internal: true })
  const [start] = inProcess
  assert.ok(start)
  await assert.rejects(start.run(signal()), failsWith(/has no connected handler script/))
})

// ── listing ──────────────────────────────────────────────────────────

function properties(tool: ListedTool | undefined): Record<string, unknown> {
  return (tool?.inputSchema.properties ?? {}) as Record<string, unknown>
}

test('extension and graph tools are listed as static ones are: a marked one says so, and none carries execution', async () => {
  const listed = await listDynamicTools()
  const byName = new Map(listed.map((tool) => [tool.name, tool]))
  assert.doesNotMatch(JSON.stringify(listed), /"execution"/)
  for (const tool of listed) {
    assert.deepEqual(Object.keys(tool).sort(), ['description', 'inputSchema', 'name'], `${tool.name} carries more`)
  }

  assert.equal(byName.get(EXT.async)?.description, `Index the repository. ${ASYNC_SENTENCE}`)
  assert.deepEqual(byName.get(EXT.async)?.inputSchema, SCHEMA, 'an async tool asks nothing new')
  assert.equal(byName.get(EXT.awaitable)?.description, `Build it. ${AWAITABLE_SENTENCE}`)
  assert.deepEqual(Object.keys(properties(byName.get(EXT.awaitable))), ['region', 'background', 'timeoutMinutes'])
  assert.equal(byName.get(EXT.sync)?.description, 'Look at it.')
  assert.deepEqual(byName.get(EXT.sync)?.inputSchema, SCHEMA)
  assert.equal(byName.get(EXT.misspelt)?.description, 'Misspelt.', 'a mode nobody can read is no mode')

  assert.equal(byName.get(GRAPH.async.name)?.description, `Graph tool ${GRAPH.async.name}. ${ASYNC_SENTENCE}`)
  assert.deepEqual(Object.keys(properties(byName.get(GRAPH.async.name))), ['q'])
  assert.deepEqual(Object.keys(properties(byName.get(GRAPH.awaitable.name))), ['q', 'background', 'timeoutMinutes'])
  assert.equal(byName.get(GRAPH.sync.name)?.description, `Graph tool ${GRAPH.sync.name}.`)
  assert.deepEqual(Object.keys(properties(byName.get(GRAPH.sync.name))), ['q'])
})

// ── remote_exec / remote_script: the runner adapters ─────────────────

test('remote_exec with background: true starts a runner task for the calling session and says so', async () => {
  const { runnerTasks, inProcess } = fakeService()
  const result = await handleToolCall(
    'remote_exec',
    {
      target: TARGET,
      command: 'npm test',
      cwd: 'server',
      secrets: ['DEPLOY_TOKEN'],
      description: 'Run the tests',
      background: true,
      timeoutMinutes: 90,
    },
    { internal: true, callerAgent: 'Background Agent', callerSessionId: 'session-1' },
  )
  assert.deepEqual(runnerTasks, [
    {
      target: TARGET,
      mode: 'command',
      command: 'npm test',
      // Resolved against the target's own directory, as the in-place path does.
      cwd: join(root, SLUG, 'server'),
      // Names, unresolved: none of these is stored anywhere, and the start still
      // goes through — the values are the service's to put in the environment.
      secrets: ['DEPLOY_TOKEN'],
      summary: 'Run the tests',
      owner: { agent: 'Background Agent', sessionId: 'session-1' },
      name: 'remote_exec',
      timeoutMs: 5_400_000,
    },
  ])
  assert.equal(inProcess.length, 0, 'a tool with a runner adapter never runs in this process')
  assert.equal(
    text(result),
    'Started background task task-1 — Run the tests. Its result will arrive in this conversation when it ends.',
  )
})

test('a remote_exec caller with no session gets its task anyway, and is told nothing will arrive', async () => {
  const { runnerTasks } = fakeService()
  const result = await handleToolCall(
    'remote_exec',
    { target: TARGET, command: 'sleep 5', description: 'Nap', background: true },
    { internal: true },
  )
  assert.deepEqual(runnerTasks[0]?.owner, { agent: null })
  assert.equal(runnerTasks[0]?.timeoutMs, 3_600_000, 'an hour when the caller does not say')
  assert.match(text(result), /No notification will arrive: this caller has no session/)
})

test('timeoutMinutes 0 is no limit; a malformed one is refused before anything starts', async () => {
  const { runnerTasks } = fakeService()
  await handleToolCall(
    'remote_exec',
    { target: TARGET, command: './train.sh', description: 'Train overnight', background: true, timeoutMinutes: 0 },
    { internal: true },
  )
  assert.equal(runnerTasks[0]?.timeoutMs, null)
  for (const timeoutMinutes of [-1, '30']) {
    await assert.rejects(
      handleToolCall(
        'remote_exec',
        { target: TARGET, command: './train.sh', description: 'Train', background: true, timeoutMinutes },
        { internal: true },
      ),
      failsWith(/timeoutMinutes must be a number/, -32602),
    )
  }
  assert.equal(runnerTasks.length, 1)
})

test('with no description a command task is known by its first line', async () => {
  const { runnerTasks } = fakeService()
  await handleToolCall(
    'remote_exec',
    { target: TARGET, command: '\n  make release  \nmake publish', background: true },
    { internal: true },
  )
  assert.equal(runnerTasks[0]?.summary, 'make release')
})

test('a backgrounded call is validated like one run in place', async () => {
  const { runnerTasks } = fakeService()
  await assert.rejects(
    handleToolCall('remote_exec', { target: TARGET, background: true }, { internal: true }),
    failsWith(/Missing required param: command/),
  )
  await assert.rejects(
    handleToolCall('remote_script', { target: TARGET, background: true }, { internal: true }),
    failsWith(/Missing required param: script/),
  )
  await assert.rejects(
    handleToolCall(
      'remote_exec',
      { target: `extensions/no-such-${suffix}`, command: 'ls', background: true },
      {
        internal: true,
      },
    ),
    failsWith(/Unknown local extension/),
  )
  assert.equal(runnerTasks.length, 0)
})

test('remote_script in the background carries its body and its positional arguments apart, as the in-place path does', async () => {
  const { runnerTasks } = fakeService()
  const script = 'printf "%s|" "$@"\necho "$#"'
  await handleToolCall(
    'remote_script',
    { target: TARGET, script, args: ['a b', "it's"], description: 'Echo the arguments', background: true },
    { internal: true, callerSessionId: 'session-2' },
  )
  const [task] = runnerTasks
  assert.equal(task?.name, 'remote_script')
  assert.equal(task?.mode, 'script')
  assert.equal(task?.summary, 'Echo the arguments')
  assert.deepEqual(task?.owner, { agent: null, sessionId: 'session-2' })
  assert.equal(task?.command, script, 'the body goes as written')
  assert.deepEqual(task?.args, ['a b', "it's"])
  // Run it the way the node will — `bash script.sh <args>` — and the arguments
  // must arrive as they would have in place.
  const dir = mkdtempSync(join(tmpdir(), 'remote-script-args-'))
  try {
    const file = join(dir, 'script.sh')
    writeFileSync(file, task?.command ?? '')
    assert.equal(execFileSync('bash', [file, ...(task?.args ?? [])], { encoding: 'utf8' }), "a b|it's|2\n")
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }

  await handleToolCall(
    'remote_script',
    { target: TARGET, script, description: 'No arguments', background: true },
    { internal: true },
  )
  assert.equal(runnerTasks[1]?.command, script, 'with none, the body goes as written')
  assert.equal(runnerTasks[1]?.args, undefined, 'and no argument list at all')
})

// The in-place path resolves secrets before it runs anything; the background
// path hands them over as names. So a secret nobody stored fails the one and not
// the other, which shows which path ran without running a command.
test('without background: true — absent, false, or not a boolean — the call runs in place as before', async () => {
  const { runnerTasks, inProcess } = fakeService()
  const missing = `NO_SUCH_SECRET_${suffix.toUpperCase()}`
  for (const background of [undefined, false, 'true']) {
    const flag = background === undefined ? {} : { background }
    await assert.rejects(
      handleToolCall(
        'remote_exec',
        { target: TARGET, command: 'echo hi', description: 'Say hi', secrets: [missing], ...flag },
        { internal: true, callerSessionId: 'session-3' },
      ),
      failsWith(new RegExp(`Secret "${missing}" not found`)),
    )
    await assert.rejects(
      handleToolCall(
        'remote_script',
        { target: TARGET, script: 'echo hi', description: 'Say hi', secrets: [missing], ...flag },
        { internal: true, callerSessionId: 'session-3' },
      ),
      failsWith(new RegExp(`Secret "${missing}" not found`)),
    )
  }
  assert.equal(runnerTasks.length, 0)
  assert.equal(inProcess.length, 0)
})

for (const tool of ['remote_exec', 'remote_script'] as const) {
  const body = tool === 'remote_exec' ? { command: './deploy.sh' } : { script: './deploy.sh' }

  test(`${tool}: a backgrounded call still waits for approval, and a rejected one starts nothing`, async () => {
    const { runnerTasks } = fakeService()
    setYoloMode(false)
    approvalStore.setAutoApprove(false)
    const call = handleToolCall(
      tool,
      { target: TARGET, ...body, description: 'Deploy', background: true },
      { internal: false, callerSessionId: 'session-4' },
    )
    const request = await pendingApproval(tool)
    assert.equal(request.args.background, true, 'the approver is shown that it would run detached')
    assert.equal(runnerTasks.length, 0, 'nothing starts while the approval is pending')
    approvalStore.reject(request.id, 'not now')
    const result = await call
    assert.equal(result.isError, true)
    assert.match(text(result), /not now/)
    assert.equal(runnerTasks.length, 0, 'and nothing starts after a rejection')
  })

  test(`${tool}: an approved background call starts once the approval lands`, async () => {
    const { runnerTasks } = fakeService()
    setYoloMode(false)
    approvalStore.setAutoApprove(false)
    const call = handleToolCall(
      tool,
      { target: TARGET, ...body, description: 'Deploy', background: true },
      { internal: false, callerSessionId: 'session-5' },
    )
    const request = await pendingApproval(tool)
    assert.equal(runnerTasks.length, 0)
    approvalStore.approve(request.id)
    assert.match(text(await call), /^Started background task/)
    assert.equal(runnerTasks.length, 1)
    assert.deepEqual(runnerTasks[0]?.owner, { agent: null, sessionId: 'session-5' })
  })
}

// ── actions ──────────────────────────────────────────────────────────

type ListedAction = {
  actionId?: string
  id?: string
  description?: string
  inputSchema?: { properties?: Record<string, unknown> }
}

function checkListing(raw: string, idOf: (action: ListedAction) => string | undefined): void {
  assert.doesNotMatch(raw, /"execution"/, 'the mode is said through the schema, never as a field')
  const byId = Object.fromEntries((JSON.parse(raw) as ListedAction[]).map((action) => [idOf(action), action]))
  assert.deepEqual(Object.keys(byId.build?.inputSchema?.properties ?? {}), ['region', 'background', 'timeoutMinutes'])
  assert.equal(byId.build?.description, undefined, 'an awaitable action gains no sentence')
  assert.equal(byId.deploy?.description, `Deploy it. ${ASYNC_SENTENCE}`)
  assert.equal(byId.deploy?.inputSchema, undefined, 'an async action asks nothing new')
  assert.deepEqual(byId.status?.inputSchema, SCHEMA, 'a sync action is listed as declared')
  assert.equal(byId.status?.description, undefined)
}

test('list_actions presents each action by its declared mode', async () => {
  const result = await handleToolCall('list_actions', { nodeId: NODE_ID }, { internal: true })
  checkListing(text(result), (action) => action.actionId)
})

test('app_actions presents each action by its declared mode, by type and by address alike', async () => {
  for (const app of [`${SLUG}-app`, APP_ADDRESS]) {
    const result = await handleToolCall('app_actions', { app }, { internal: true })
    checkListing(text(result), (action) => action.id)
  }
})

test('call on an async node action starts an in-process task, named from the manifest', async () => {
  const { inProcess } = fakeService()
  const result = await handleToolCall(
    'call',
    { nodeId: NODE_ID, action: 'deploy', params: { region: 'eu' } },
    { internal: true, callerSessionId: 'session-6' },
  )
  assert.equal(
    text(result),
    `Started background task task-1 — Deploy on ${NODE_ID}. Its result will arrive in this conversation when it ends.`,
    'the same answer a tool gives',
  )
  assert.equal(inProcess.length, 1)
  const [start] = inProcess
  assert.deepEqual(
    {
      owner: start?.owner,
      kind: start?.kind,
      name: start?.name,
      target: start?.target,
      summary: start?.summary,
      timeoutMs: start?.timeoutMs,
    },
    {
      owner: { agent: null, sessionId: 'session-6' },
      kind: 'node-action',
      name: 'deploy',
      target: NODE_ID,
      summary: `Deploy on ${NODE_ID}`,
      timeoutMs: 3_600_000,
    },
  )
})

test('call on an awaitable node action with background: true takes the caller’s timeout', async () => {
  const { inProcess } = fakeService()
  await handleToolCall(
    'call',
    { nodeId: NODE_ID, action: 'build', params: { region: 'eu', background: true, timeoutMinutes: 10 } },
    { internal: true },
  )
  assert.equal(inProcess[0]?.name, 'build')
  assert.equal(inProcess[0]?.timeoutMs, 600_000)
})

test('app_call on an async action starts a task under the app’s address, whichever reference was used', async () => {
  const { inProcess } = fakeService()
  for (const app of [APP_ADDRESS, appRow.id]) {
    await handleToolCall('app_call', { app, action: 'deploy' }, { internal: true })
  }
  assert.deepEqual(
    inProcess.map((start) => [start.kind, start.name, start.target, start.summary]),
    [
      ['app-action', 'deploy', APP_ADDRESS, `Deploy on ${APP_ADDRESS}`],
      ['app-action', 'deploy', APP_ADDRESS, `Deploy on ${APP_ADDRESS}`],
    ],
    'a uuid reference is never what the task is listed under',
  )
})

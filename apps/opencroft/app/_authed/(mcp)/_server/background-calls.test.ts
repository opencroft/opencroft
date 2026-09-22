// The calls that start background work, end to end through handleToolCall:
// remote_exec and remote_script with `background`, and `call`/`app_call` on
// actions whose manifest says how callers wait. What is asserted is what
// reaches the service — the command, the target, the owner, the limit — and
// that the approval gate still stands in front of it.
//
// A local extension written into a scratch root stands in for the extensions
// that really declare such actions, which live in other repositories. It also
// gives the remote tools a target, `extensions/<slug>`, that resolves without a
// node. The service is a stand-in: nothing here starts a process.
//
// Exercises the real database (embedded PGlite) — see @opencroft/db's test-env.
import '@opencroft/db/test-env'

import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test, { after, afterEach } from 'node:test'

import { db, spaceApp } from '@opencroft/db'

import type {
  BackgroundTaskRecord,
  BackgroundTaskService,
  StartInProcessTaskInput,
  StartNodeTaskInput,
} from '@/app/_authed/(background-tasks)/_server/types'
import { getSpacesRegistry } from '@/app/_authed/(space)/_server/store'
import { approvalStore } from '@/lib/approval-store'
import { ASYNC_SENTENCE } from './execution-mode'
import { handleToolCall } from './tools'
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
mkdirSync(join(root, SLUG))
writeFileSync(
  join(root, SLUG, 'extension.json'),
  JSON.stringify({
    id: `local/${SLUG}`,
    name: 'Background-call fixture',
    version: '0.0.0',
    nodes: [{ typeId: `${SLUG}-node`, name: 'Fixture node', actions: ACTIONS }],
    provides: { apps: [{ slug: `${SLUG}-app`, title: 'Fixture app', actions: ACTIONS }] },
  }),
)

const registry = getSpacesRegistry()
await registry.ensureLoaded()
const spaceSlug = `background-calls-${suffix}`
const NODE_ID = `bgfix-node-${suffix}`
const space = await registry.create(spaceSlug, spaceSlug, {
  nodes: [{ id: NODE_ID, type: `${SLUG}-node`, position: { x: 0, y: 0 }, data: {} }],
  edges: [],
})
const [appRow] = await db
  .insert(spaceApp)
  .values({ spaceId: space.id, extensionId: `local/${SLUG}`, appSlug: `${SLUG}-app`, name: 'Fixture', slug: 'fixture' })
  .returning()
const APP_ADDRESS = `${spaceSlug}.fixture`

// ── the stand-in service ─────────────────────────────────────────────

function fakeService() {
  const nodeTasks: StartNodeTaskInput[] = []
  const inProcess: StartInProcessTaskInput[] = []
  const started = (
    input: Pick<StartNodeTaskInput, 'owner' | 'name' | 'target' | 'summary' | 'timeoutMs'>,
    kind: BackgroundTaskRecord['kind'],
  ): BackgroundTaskRecord => ({
    taskId: `task-${nodeTasks.length + inProcess.length}`,
    agent: input.owner.agent,
    kind,
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
    startNodeTask: async (input) => {
      nodeTasks.push(input)
      return started(input, 'tool')
    },
    startInProcessTask: async (input) => {
      inProcess.push(input)
      return started({ ...input, name: 'remote_exec' }, input.kind)
    },
    get: unexpected,
    listForOwner: unexpected,
    listRunning: unexpected,
    cancel: unexpected,
    runningSessionKeys: () => new Set(),
  }
  substituteBackgroundTaskService(service)
  return { nodeTasks, inProcess }
}

afterEach(() => substituteBackgroundTaskService(undefined))

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

// ── remote_exec / remote_script ──────────────────────────────────────

test('remote_exec with background: true starts a node task for the calling session and says so', async () => {
  const { nodeTasks } = fakeService()
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
  assert.deepEqual(nodeTasks, [
    {
      owner: { agent: 'Background Agent', sessionId: 'session-1' },
      name: 'remote_exec',
      target: TARGET,
      command: 'npm test',
      // Resolved against the target's own directory, as the in-place path does.
      cwd: join(root, SLUG, 'server'),
      // Names, unresolved: none of these is stored anywhere, and the start still
      // goes through — the values are the service's to put in the environment.
      secrets: ['DEPLOY_TOKEN'],
      timeoutMs: 5_400_000,
      summary: 'Run the tests',
    },
  ])
  assert.match(text(result), /^Started background task task-1 — Run the tests \(times out after 1h 30m\)\./)
  assert.match(text(result), /will arrive in this conversation/)
})

test('a caller with no session gets its task anyway, and is told nothing will arrive', async () => {
  const { nodeTasks } = fakeService()
  const result = await handleToolCall(
    'remote_exec',
    { target: TARGET, command: 'sleep 5', description: 'Nap', background: true },
    { internal: true },
  )
  assert.deepEqual(nodeTasks[0]?.owner, { agent: null })
  assert.equal(nodeTasks[0]?.timeoutMs, 3_600_000, 'an hour when the caller does not say')
  assert.match(text(result), /No notification will arrive: this caller has no session/)
})

test('timeoutMinutes 0 is no limit; a malformed one is refused before anything starts', async () => {
  const { nodeTasks } = fakeService()
  await handleToolCall(
    'remote_exec',
    { target: TARGET, command: './train.sh', description: 'Train overnight', background: true, timeoutMinutes: 0 },
    { internal: true },
  )
  assert.equal(nodeTasks[0]?.timeoutMs, null)
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
  assert.equal(nodeTasks.length, 1)
})

test('with no description a command task is known by its first line', async () => {
  const { nodeTasks } = fakeService()
  await handleToolCall(
    'remote_exec',
    { target: TARGET, command: '\n  make release  \nmake publish', background: true },
    { internal: true },
  )
  assert.equal(nodeTasks[0]?.summary, 'make release')
})

test('a backgrounded call is validated like one run in place', async () => {
  const { nodeTasks } = fakeService()
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
  assert.equal(nodeTasks.length, 0)
})

test('remote_script in the background carries its body and its positional arguments apart, as the in-place path does', async () => {
  const { nodeTasks } = fakeService()
  const script = 'printf "%s|" "$@"\necho "$#"'
  await handleToolCall(
    'remote_script',
    { target: TARGET, script, args: ['a b', "it's"], description: 'Echo the arguments', background: true },
    { internal: true, callerSessionId: 'session-2' },
  )
  const [task] = nodeTasks
  assert.equal(task?.name, 'remote_script')
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
  assert.equal(nodeTasks[1]?.command, script, 'with none, the body goes as written')
  assert.equal(nodeTasks[1]?.args, undefined, 'and no argument list at all')
})

// The in-place path resolves secrets before it runs anything; the background
// path hands them over as names. So a secret nobody stored fails the one and not
// the other, which shows which path ran without running a command.
test('without background: true — absent, false, or not a boolean — the call runs in place as before', async () => {
  const { nodeTasks } = fakeService()
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
  assert.equal(nodeTasks.length, 0)
})

for (const tool of ['remote_exec', 'remote_script'] as const) {
  const body = tool === 'remote_exec' ? { command: './deploy.sh' } : { script: './deploy.sh' }

  test(`${tool}: a backgrounded call still waits for approval, and a rejected one starts nothing`, async () => {
    const { nodeTasks } = fakeService()
    setYoloMode(false)
    approvalStore.setAutoApprove(false)
    const call = handleToolCall(
      tool,
      { target: TARGET, ...body, description: 'Deploy', background: true },
      { internal: false, callerSessionId: 'session-4' },
    )
    const request = await pendingApproval(tool)
    assert.equal(request.args.background, true, 'the approver is shown that it would run detached')
    assert.equal(nodeTasks.length, 0, 'nothing starts while the approval is pending')
    approvalStore.reject(request.id, 'not now')
    const result = await call
    assert.equal(result.isError, true)
    assert.match(text(result), /not now/)
    assert.equal(nodeTasks.length, 0, 'and nothing starts after a rejection')
  })

  test(`${tool}: an approved background call starts once the approval lands`, async () => {
    const { nodeTasks } = fakeService()
    setYoloMode(false)
    approvalStore.setAutoApprove(false)
    const call = handleToolCall(
      tool,
      { target: TARGET, ...body, description: 'Deploy', background: true },
      { internal: false, callerSessionId: 'session-5' },
    )
    const request = await pendingApproval(tool)
    assert.equal(nodeTasks.length, 0)
    approvalStore.approve(request.id)
    assert.match(text(await call), /^Started background task/)
    assert.equal(nodeTasks.length, 1)
    assert.deepEqual(nodeTasks[0]?.owner, { agent: null, sessionId: 'session-5' })
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
  assert.match(text(result), /^Started background task task-1 — /)
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

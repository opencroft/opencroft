// How an execution mode reaches a caller: through the schema and the
// description, never as a field of its own (product decision — the caller reads
// the schema it already reads, and learns nothing new to do so).
//
// The fixtures are declared here rather than looked up: the concrete async
// actions — a node's deploy, the git App's clone — live in extensions this
// repository does not hold. The registry assertions are about the two tools
// this repository itself makes awaitable, and about the listing as a whole.
import '@opencroft/db/test-env'

import assert from 'node:assert/strict'
import test from 'node:test'

import {
  type ActionDeclaration,
  ASYNC_SENTENCE,
  AWAITABLE_SENTENCE,
  BACKGROUND_PROPERTIES,
  backgroundRunLabel,
  DEFAULT_TIMEOUT_MINUTES,
  presentAction,
  presentTool,
} from './execution-mode'
import { toolDefinitions } from './tools'

type Mode = 'sync' | 'awaitable' | 'async'

const SCHEMA = {
  type: 'object' as const,
  properties: { target: { type: 'string', description: 'Where it runs.' } },
  required: ['target'],
}

function declaredTool(execution?: Mode) {
  return {
    name: 'fixture_tool',
    description: 'Do the thing.',
    inputSchema: structuredClone(SCHEMA),
    ...(execution ? { execution } : {}),
  }
}

function properties(schema: Record<string, unknown> | undefined): Record<string, unknown> {
  return (schema?.properties ?? {}) as Record<string, unknown>
}

// ── tools ────────────────────────────────────────────────────────────

test('an awaitable tool gains both background parameters, neither required, and one sentence', () => {
  const listed = presentTool(declaredTool('awaitable'))
  assert.deepEqual(Object.keys(properties(listed.inputSchema)), ['target', 'background', 'timeoutMinutes'])
  assert.deepEqual(properties(listed.inputSchema).background, BACKGROUND_PROPERTIES.background)
  assert.deepEqual(properties(listed.inputSchema).timeoutMinutes, BACKGROUND_PROPERTIES.timeoutMinutes)
  assert.deepEqual(listed.inputSchema.required, ['target'], 'waiting stays the default, so neither is required')
  assert.equal(listed.description, `Do the thing. ${AWAITABLE_SENTENCE}`)
})

test('async and sync schemas are byte-identical; only the async description says the answer comes later', () => {
  const asyncTool = presentTool(declaredTool('async'))
  const syncTool = presentTool(declaredTool('sync'))
  assert.equal(JSON.stringify(asyncTool.inputSchema), JSON.stringify(syncTool.inputSchema))
  assert.equal(JSON.stringify(syncTool.inputSchema), JSON.stringify(SCHEMA), 'and both are the schema as declared')
  assert.equal(asyncTool.description, `Do the thing. ${ASYNC_SENTENCE}`)
  assert.equal(syncTool.description, 'Do the thing.')
})

test('an undeclared mode is sync: the tool is listed exactly as declared', () => {
  assert.equal(JSON.stringify(presentTool(declaredTool())), JSON.stringify(presentTool(declaredTool('sync'))))
})

test('no listed tool carries `execution`, whatever it declared', () => {
  for (const mode of ['sync', 'awaitable', 'async', undefined] as const) {
    assert.equal('execution' in presentTool(declaredTool(mode)), false, `${mode} reached the caller`)
  }
})

test('the registry both surfaces serve: remote_exec and remote_script offer the choice, nothing shows `execution`', () => {
  for (const tool of toolDefinitions) {
    assert.equal('execution' in tool, false, `${tool.name} carries \`execution\` into what callers receive`)
  }
  for (const name of ['remote_exec', 'remote_script']) {
    const tool = toolDefinitions.find((t) => t.name === name)
    assert.ok(tool, `${name} is listed`)
    assert.ok('background' in properties(tool.inputSchema), `${name} offers background`)
    assert.ok('timeoutMinutes' in properties(tool.inputSchema), `${name} offers timeoutMinutes`)
    assert.ok(tool.description.endsWith(AWAITABLE_SENTENCE), `${name} says so in its description`)
  }
  // The control: a sync tool beside them is untouched, so the two above are not
  // an artefact of everything having been augmented.
  const read = toolDefinitions.find((t) => t.name === 'remote_read')
  assert.ok(read)
  assert.equal('background' in properties(read.inputSchema), false)
})

// ── actions ──────────────────────────────────────────────────────────

const ACTION = {
  nodeId: 'node_1',
  actionId: 'deploy',
  label: 'Deploy',
  description: 'Deploy the app.',
  inputSchema: structuredClone(SCHEMA),
}

test('an awaitable action gains both parameters, and its description is left alone', () => {
  const listed = presentAction({ ...ACTION, execution: 'awaitable' as Mode })
  assert.deepEqual(Object.keys(properties(listed.inputSchema)), ['target', 'background', 'timeoutMinutes'])
  assert.equal(listed.description, 'Deploy the app.')
})

test('an async action gains the sentence and keeps its schema byte for byte', () => {
  const listed = presentAction({ ...ACTION, execution: 'async' as Mode })
  assert.equal(JSON.stringify(listed.inputSchema), JSON.stringify(SCHEMA))
  assert.equal(listed.description, `Deploy the app. ${ASYNC_SENTENCE}`)
})

test('an action keeps every field it came with except `execution`', () => {
  for (const mode of ['sync', 'awaitable', 'async', undefined] as const) {
    const listed = presentAction({ ...ACTION, ...(mode ? { execution: mode } : {}) })
    assert.equal('execution' in listed, false, `${mode} reached the listing`)
    assert.deepEqual(Object.keys(listed), Object.keys(ACTION), `${mode} changed the listing's shape`)
    assert.equal(listed.nodeId, 'node_1')
    assert.equal(listed.label, 'Deploy')
  }
  const sync = presentAction({ ...ACTION, execution: 'sync' as Mode })
  assert.equal(JSON.stringify(sync), JSON.stringify(ACTION), 'a sync action is listed as declared')
})

// Typed as the manifest types them, where both fields are optional.
function presentDeclared(action: { id: string } & ActionDeclaration) {
  return presentAction(action)
}

test('an awaitable action that declares no schema is given one holding the two parameters', () => {
  const listed = presentDeclared({ id: 'pull', execution: 'awaitable' })
  assert.deepEqual(listed.inputSchema, { type: 'object', properties: BACKGROUND_PROPERTIES })
})

test('an async action with no description gets the sentence alone; one without a full stop gets one', () => {
  assert.equal(presentDeclared({ id: 'clone', execution: 'async' }).description, ASYNC_SENTENCE)
  assert.equal(
    presentDeclared({ id: 'clone', description: 'Clone the repository', execution: 'async' }).description,
    `Clone the repository. ${ASYNC_SENTENCE}`,
  )
})

// What the person approving a remote_exec / remote_script call is told about how
// it will run. A detached command outlives the call, so the approval has to say
// so — and say the limit the service will actually enforce.
test('the approval says nothing about background for a call that runs in place', () => {
  assert.equal(backgroundRunLabel({ command: 'make' }), undefined)
  assert.equal(backgroundRunLabel({ command: 'make', background: false }), undefined)
  assert.equal(backgroundRunLabel({ command: 'make', background: 'true' }), undefined)
})

test('the approval states the limit a backgrounded call will run under', () => {
  assert.equal(
    backgroundRunLabel({ background: true }),
    `In the background, stopped after ${DEFAULT_TIMEOUT_MINUTES} min`,
  )
  assert.equal(
    backgroundRunLabel({ background: true, timeoutMinutes: 480 }),
    'In the background, stopped after 480 min',
  )
  assert.equal(backgroundRunLabel({ background: true, timeoutMinutes: 0 }), 'In the background, with no time limit')
})

test('an invalid limit is shown as the refusal it will be, never as the default', () => {
  const label = backgroundRunLabel({ background: true, timeoutMinutes: -5 })
  assert.match(label ?? '', /invalid time limit \(-5\)/)
  assert.doesNotMatch(label ?? '', new RegExp(`${DEFAULT_TIMEOUT_MINUTES} min`))
})

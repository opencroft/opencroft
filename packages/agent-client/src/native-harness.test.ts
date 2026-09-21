import assert from 'node:assert/strict'
import test from 'node:test'

import { buildConfigOptions, CANCELLED, raceAbort, toolPermissionDecision } from './native-harness'

// raceAbort backs the permission gate a tool call waits on: without it, a
// promise that eventually resolves after its turn was cancelled would still
// let the caller proceed as if nothing had happened.
test('resolves to the promise value when it settles before the signal aborts', async () => {
  const controller = new AbortController()
  const result = await raceAbort(Promise.resolve('allowed'), controller.signal)
  assert.equal(result, 'allowed')
})

test('resolves to CANCELLED when the signal aborts before the promise settles, and ignores the late settlement', async () => {
  const controller = new AbortController()
  let settleLate: (value: string) => void = () => {}
  const late = new Promise<string>((resolve) => {
    settleLate = resolve
  })

  const raced = raceAbort(late, controller.signal)
  controller.abort()
  assert.equal(await raced, CANCELLED)

  // The late resolution must not throw or otherwise surface once nothing is
  // listening for it — this simulates a permission response arriving after
  // the turn that asked for it has already moved on.
  settleLate('allowed-too-late')
})

test('an already-aborted signal short-circuits without waiting on the promise at all', async () => {
  const controller = new AbortController()
  controller.abort()
  const neverSettles = new Promise<string>(() => {})
  const result = await raceAbort(neverSettles, controller.signal)
  assert.equal(result, CANCELLED)
})

test('a rejection before abort propagates as a rejection, not as CANCELLED', async () => {
  const controller = new AbortController()
  await assert.rejects(raceAbort(Promise.reject(new Error('boom')), controller.signal), /boom/)
})

test('with no signal at all, the promise is returned untouched', async () => {
  const result = await raceAbort(Promise.resolve('value'), undefined)
  assert.equal(result, 'value')
})

// The session's permission mode, resolved against the grant a session's roles
// already produced for one tool. Stated as a table because the interesting part
// is the whole matrix, not any single cell.

test('a mode that skips the prompt allows the call outright', () => {
  assert.equal(toolPermissionDecision('bypass', 'Allow'), 'allow')
  assert.equal(toolPermissionDecision('accept-edits', 'Allow'), 'allow')
})

test('the reject mode declines without asking', () => {
  assert.equal(toolPermissionDecision('reject-edits', 'Allow'), 'deny')
})

test('the manual mode asks', () => {
  assert.equal(toolPermissionDecision('manual-edits', 'Allow'), 'ask')
})

test('an AlwaysAllow grant outranks every mode except an explicit refusal', () => {
  assert.equal(toolPermissionDecision('manual-edits', 'AlwaysAllow'), 'allow')
  // Even reject: the grant is a per-tool decision the host made deliberately,
  // and the mode is only the default it sits inside.
  assert.equal(toolPermissionDecision('reject-edits', 'AlwaysAllow'), 'allow')
})

test('an unknown mode asks rather than assuming permission', () => {
  // 'default' is what sessions created before these modes existed still carry;
  // plan and auto are advertised only by ACP agents.
  for (const mode of ['default', 'plan', 'auto', '']) {
    assert.equal(toolPermissionDecision(mode, 'Allow'), 'ask', mode)
  }
})

// What the harness advertises over the config-option surface. The client picks
// these out by id and gives each its own control, so both the ids and the
// decision to omit an option entirely are part of the contract.

// Only the fields buildConfigOptions reads. Cast rather than filled out: the
// full selection carries a dozen transport fields none of this touches.
const selectionFor = (model: string, providerId = 'openai', reasoningEffort?: string) =>
  ({ model, providerId, reasoningEffort }) as unknown as Parameters<typeof buildConfigOptions>[1]

const sessionFor = (over: Partial<Parameters<typeof buildConfigOptions>[0]> = {}) =>
  ({ messages: [], mode: 'manual-edits', ...over }) as Parameters<typeof buildConfigOptions>[0]

const byId = (options: ReturnType<typeof buildConfigOptions>, id: string) =>
  options.find((option) => option.id === id) as { currentValue?: unknown; options?: { value: string }[] } | undefined

test('the permission mode is always advertised, at the id the composer reads', () => {
  const mode = byId(buildConfigOptions(sessionFor(), selectionFor('gpt-5')), 'mode')
  assert.ok(mode)
  assert.equal(mode.currentValue, 'manual-edits')
  assert.deepEqual(
    mode.options?.map((o) => o.value),
    ['manual-edits', 'accept-edits', 'reject-edits', 'bypass'],
  )
})

test('every option names the ACP category for its meaning, not only its id', () => {
  // The id is what the composer keys on; `category` is what the protocol marks
  // the meaning with, and what the engine reads to find the model a session is
  // running. With the categories missing, a Custom session kept reporting its
  // profile's model after a live switch — the option held the new one and
  // nothing looked at it.
  const options = buildConfigOptions(sessionFor(), selectionFor('gpt-5'))
  assert.deepEqual(
    options.map((option) => [option.id, option.category]),
    [
      ['mode', 'mode'],
      ['model', 'model'],
      ['effort', 'thought_level'],
    ],
  )
})

test('a model with no known reasoning levels advertises no effort option at all', () => {
  // An empty dropdown is worse than no control: it invites a choice that does
  // not exist.
  assert.equal(byId(buildConfigOptions(sessionFor(), selectionFor('some-plain-model')), 'effort'), undefined)
})

test('a reasoning model offers the grades it takes, and does not claim an off it cannot send', () => {
  // 'off' would mean an instruction not to think, which an OpenAI-compatible
  // endpoint has no way to express. The client adds 'default' itself.
  const effort = byId(buildConfigOptions(sessionFor(), selectionFor('gpt-5')), 'effort')
  assert.ok(effort)
  assert.ok((effort.options?.length ?? 0) > 0)
  assert.ok(!effort.options?.some((o) => o.value === 'off'))
})

test('a session choice outranks the profile for both model and effort', () => {
  const options = buildConfigOptions(
    sessionFor({ model: 'gpt-5', effort: 'high' }),
    selectionFor('gpt-4o', 'openai', 'low'),
  )
  assert.equal(byId(options, 'model')?.currentValue, 'gpt-5')
  assert.equal(byId(options, 'effort')?.currentValue, 'high')
})

test('a model the provider list does not name still appears, or it could not be returned to', () => {
  const model = byId(buildConfigOptions(sessionFor(), selectionFor('custom-deployment')), 'model')
  assert.ok(model?.options?.some((o) => o.value === 'custom-deployment'))
})

test('what the endpoint reports outranks the provider table', () => {
  // The table lists gpt-5/gpt-5-codex for this provider; the endpoint is the
  // one that knows what it actually serves.
  const model = byId(
    buildConfigOptions(sessionFor(), selectionFor('gpt-5'), [{ id: 'gpt-5' }, { id: 'local-mixtral' }]),
    'model',
  )
  assert.deepEqual(
    model?.options?.map((o) => o.value),
    ['gpt-5', 'local-mixtral'],
  )
})

test('an endpoint that reports nothing falls back to the provider table', () => {
  const model = byId(buildConfigOptions(sessionFor(), selectionFor('gpt-5'), []), 'model')
  assert.ok((model?.options?.length ?? 0) > 1)
})

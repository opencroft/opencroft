// Exercises credential resolution and caller recording against a real
// (throwaway) database rather than a mock. What is worth proving is that the
// table definitions, the migrations and the upsert actually agree — a mock
// would hide exactly the disagreement that matters.
//
// PGLITE_PATH, DB_MIGRATIONS_DIR and OPENCROFT_DATA_DIR are set before
// importing anything that touches the db package: `@opencroft/db` opens the
// connection and migrates at import time, so the environment has to be in
// place first.

import assert from 'node:assert/strict'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test, { after } from 'node:test'

const workdir = await mkdtemp(join(tmpdir(), 'opencroft-caller-test-'))
process.env.PGLITE_PATH = join(workdir, 'pglite')
process.env.DB_MIGRATIONS_DIR = join(import.meta.dirname, '..', '..', '..', '..', '..', '..', 'packages', 'db', 'migrations')
process.env.OPENCROFT_DATA_DIR = join(workdir, 'data')
process.env.OPENCROFT_MCP_AUTH = 'observe'
delete process.env.DATABASE_URL

const { apiToken, db, mcpCaller } = await import('@opencroft/db')
const { hashToken, recordCaller, refuses, resolveCaller } = await import('./caller')
const { KILL_SWITCH_PATH, mcpAuthMode, resetKillSwitchCache } = await import('./mcp-auth-mode')

after(async () => {
  await rm(workdir, { recursive: true, force: true })
})

function req(headers: Record<string, string> = {}): Request {
  return new Request('http://localhost:9999/api/mcp', { method: 'POST', headers })
}

async function mint(agent: string, token: string): Promise<string> {
  const [row] = await db
    .insert(apiToken)
    .values({ subjectType: 'agent', agentName: agent, tokenHash: hashToken(token) })
    .returning({ id: apiToken.id })
  return row.id
}

/** Run `fn` and return every `[mcp-caller]` line it emitted. */
async function captureLog(fn: () => Promise<void>): Promise<string[]> {
  const lines: string[] = []
  const original = console.log
  console.log = (...args: unknown[]) => {
    lines.push(args.map(String).join(' '))
  }
  try {
    await fn()
  } finally {
    console.log = original
  }
  return lines.filter((l) => l.startsWith('[mcp-caller]'))
}

test('no Authorization header resolves as absent, not unknown', async () => {
  const caller = await resolveCaller(req())
  assert.equal(caller.credential, 'absent')
  assert.equal(caller.agent, null)
})

test('a minted token resolves to its agent', async () => {
  await mint('alice', 'oc_test_valid_token')
  const caller = await resolveCaller(req({ authorization: 'Bearer oc_test_valid_token' }))
  assert.equal(caller.credential, 'present')
  assert.equal(caller.agent, 'alice')
})

test('the Bearer scheme is matched case-insensitively, as RFC 7235 requires', async () => {
  const caller = await resolveCaller(req({ authorization: 'bearer oc_test_valid_token' }))
  assert.equal(caller.credential, 'present')
  assert.equal(caller.agent, 'alice')
})

// The distinction this asserts is the whole point of having three states:
// `unknown` is a client that WAS configured and is now wrong, `absent` is a
// client nobody has touched. Collapsing them would make the Stage A logs
// unreadable in exactly the case that matters.
test('an unrecognised token resolves as unknown, distinct from absent', async () => {
  const caller = await resolveCaller(req({ authorization: 'Bearer oc_never_minted' }))
  assert.equal(caller.credential, 'unknown')
  assert.equal(caller.agent, null)
})

test('a revoked token stops resolving', async () => {
  const { eq } = await import('drizzle-orm')
  const id = await mint('grace', 'oc_test_to_be_revoked')

  const before = await resolveCaller(req({ authorization: 'Bearer oc_test_to_be_revoked' }))
  assert.equal(before.credential, 'present', 'must work before revocation, or the test proves nothing')

  await db.update(apiToken).set({ revokedAt: new Date() }).where(eq(apiToken.id, id))

  const after_ = await resolveCaller(req({ authorization: 'Bearer oc_test_to_be_revoked' }))
  assert.equal(after_.credential, 'unknown')
  assert.equal(after_.agent, null)
})

// Rotation with a single credential means a window where the old token is dead
// and the new one is not yet configured. Several live tokens per agent is what
// removes that window, so it is worth a test rather than an assumption.
test('an agent can hold several live tokens at once', async () => {
  await mint('carol', 'oc_test_carol_one')
  await mint('carol', 'oc_test_carol_two')

  const first = await resolveCaller(req({ authorization: 'Bearer oc_test_carol_one' }))
  const second = await resolveCaller(req({ authorization: 'Bearer oc_test_carol_two' }))

  assert.equal(first.credential, 'present')
  assert.equal(second.credential, 'present')
  assert.equal(first.agent, 'carol')
  assert.equal(second.agent, 'carol')
  assert.notEqual(first.tokenId, second.tokenId)
})

test('repeat calls from one caller aggregate onto a single row', async () => {
  const { and, eq } = await import('drizzle-orm')
  const request = req({ 'user-agent': 'probe/1.0', 'x-forwarded-for': '10.0.0.7' })
  const caller = { credential: 'absent' as const, agent: null, tokenId: null }

  for (let i = 0; i < 3; i++) {
    await recordCaller({ caller, method: 'tools/list', tool: null, request })
  }

  const rows = await db
    .select()
    .from(mcpCaller)
    .where(and(eq(mcpCaller.method, 'tools/list'), eq(mcpCaller.userAgent, 'probe/1.0')))

  assert.equal(rows.length, 1, 'three requests from one caller must be one row, not three')
  assert.equal(rows[0].seenCount, 3)
  assert.equal(rows[0].sourceIp, '10.0.0.7')
  assert.ok(rows[0].lastSeenAt >= rows[0].firstSeenAt)
})

test('callers differing only by user agent are recorded separately', async () => {
  const { eq } = await import('drizzle-orm')
  const caller = { credential: 'absent' as const, agent: null, tokenId: null }

  await recordCaller({ caller, method: 'initialize', tool: null, request: req({ 'user-agent': 'alpha/1' }) })
  await recordCaller({ caller, method: 'initialize', tool: null, request: req({ 'user-agent': 'beta/1' }) })

  const rows = await db.select().from(mcpCaller).where(eq(mcpCaller.method, 'initialize'))
  assert.equal(rows.length, 2)
})

test('tool name is part of the caller identity, so per-tool usage is visible', async () => {
  const { eq } = await import('drizzle-orm')
  const caller = { credential: 'absent' as const, agent: null, tokenId: null }
  const request = req({ 'user-agent': 'tooler/1' })

  await recordCaller({ caller, method: 'tools/call', tool: 'remote_exec', request })
  await recordCaller({ caller, method: 'tools/call', tool: 'list_nodes', request })

  const rows = await db.select().from(mcpCaller).where(eq(mcpCaller.method, 'tools/call'))
  assert.equal(rows.length, 2)
  assert.deepEqual(rows.map((r) => r.tool).sort(), ['list_nodes', 'remote_exec'])
})

test('a resolved token has its lastUsedAt stamped', async () => {
  const { eq } = await import('drizzle-orm')
  const caller = await resolveCaller(req({ authorization: 'Bearer oc_test_valid_token' }))
  await recordCaller({ caller, method: 'tools/list', tool: null, request: req({ 'user-agent': 'stamper/1' }) })

  const [row] = await db
    .select()
    .from(apiToken)
    .where(eq(apiToken.id, caller.tokenId as string))
  assert.ok(row.lastUsedAt, 'lastUsedAt must be set, or a stale token is indistinguishable from a live one')
})

// The kill switch is the recovery path for Stage B, when refusing the wrong
// caller would take out dispatch and there would be no way to report it. If it
// does not work, none of the staging is worth anything.
test('the kill switch file turns the whole thing off, with no restart', async () => {
  const { mkdir } = await import('node:fs/promises')
  assert.equal(mcpAuthMode(), 'observe', 'precondition: configured mode is observe')

  await mkdir(join(workdir, 'data'), { recursive: true })
  await writeFile(KILL_SWITCH_PATH, '')
  resetKillSwitchCache()

  assert.equal(mcpAuthMode(), 'off')

  // A valid token must now resolve as anonymous: `off` has to take this code
  // out of the request path entirely, not merely stop it refusing things.
  const caller = await resolveCaller(req({ authorization: 'Bearer oc_test_valid_token' }))
  assert.equal(caller.credential, 'absent')
  assert.equal(caller.agent, null)

  const before = (await db.select().from(mcpCaller)).length
  await recordCaller({ caller, method: 'tools/list', tool: null, request: req({ 'user-agent': 'killed/1' }) })
  assert.equal((await db.select().from(mcpCaller)).length, before, 'nothing may be recorded while off')

  await rm(KILL_SWITCH_PATH)
  resetKillSwitchCache()
  assert.equal(mcpAuthMode(), 'observe', 'removing the file must restore the configured mode')
})

// The log carries the per-request trace that the table deliberately collapses,
// so its shape is a contract rather than a debugging aid.
test('every observed request emits exactly one [mcp-caller] line', async () => {
  const caller = { credential: 'absent' as const, agent: null, tokenId: null }
  const request = req({ 'user-agent': 'liner/1.0', 'x-forwarded-for': '10.0.0.9' })

  const lines = await captureLog(async () => {
    for (let i = 0; i < 3; i++) {
      await recordCaller({ caller, method: 'tools/list', tool: null, request })
    }
  })

  assert.equal(lines.length, 3, 'the log keeps every call — collapsing them is the table’s job')
  assert.equal(lines[0], '[mcp-caller] credential=absent agent=- method=tools/list tool=- ip=10.0.0.9 ua="liner/1.0"')
})

// Stage B: `refuses` is the one decision the route defers to.
// Exercised directly against every (mode, credential) pair rather than only
// the cases expected to matter, because the property that must hold is "only
// `require` + not-`present`", and the only way to be sure nothing else
// accidentally satisfies that is to check the whole table.
test('refuses is true only for require mode with a non-present credential', () => {
  const present = { credential: 'present' as const, agent: 'carol', tokenId: 'x' }
  const absent = { credential: 'absent' as const, agent: null, tokenId: null }
  const unknown = { credential: 'unknown' as const, agent: null, tokenId: null }

  for (const mode of ['off', 'observe'] as const) {
    assert.equal(refuses(mode, present), false, `${mode} must never refuse a present credential`)
    assert.equal(refuses(mode, absent), false, `${mode} must never refuse`)
    assert.equal(refuses(mode, unknown), false, `${mode} must never refuse`)
  }

  assert.equal(refuses('require', present), false, 'require must not refuse a caller holding a valid credential')
  assert.equal(refuses('require', absent), true, 'require must refuse a caller who presented nothing')
  assert.equal(refuses('require', unknown), true, 'require must refuse a caller whose credential did not resolve')
})

// A user agent with a space or a quote must not be able to forge extra fields
// in a line someone greps and eyeballs.
test('the user agent is quoted, so it cannot forge fields in the line', async () => {
  const [line] = await captureLog(async () => {
    await recordCaller({
      caller: { credential: 'absent', agent: null, tokenId: null },
      method: 'initialize',
      tool: null,
      request: req({ 'user-agent': 'evil/1 credential=present agent=admin' }),
    })
  })

  assert.match(line, /ua="evil\/1 credential=present agent=admin"/)
  assert.equal(line.match(/credential=/g)?.length, 2, 'one real field, one inside the quoted user agent')
  assert.match(line, /^\[mcp-caller\] credential=absent /, 'the real credential stays the first field')
})

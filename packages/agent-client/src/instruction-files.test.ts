import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'

import { connectionKey, createAgentClient } from './agent-client'
import type { AgentConnection } from './connection'
import { isDeliveryNote } from './delivery-note'
import { findAdapter } from './resolve'
import {
  containerFileAccess,
  hostFileAccess,
  type InstructionTexts,
  type ShellRunner,
  writeInstructionFiles,
} from './instruction-files'
import { instructionFilePaths } from './instruction-paths'
import {
  type FoundFile,
  type FoundFiles,
  fileContent,
  planInstructionFiles,
  sidecarContent,
  sidecarPath,
} from './instruction-plan'
import type { AgentSelection } from './types'

const WORDING = 'Edit this where the agent is configured.'
const SIDECAR = sidecarContent(WORDING)
const claude = () => findAdapter('claude')?.instructions ?? assert.fail('claude declares its instruction files')
const codex = () => findAdapter('codex')?.instructions ?? assert.fail('codex declares its instruction files')

// A file found with its sidecar: the engine's own.
const owned = (path: string, content: string | null): FoundFile => ({ path, content, sidecar: SIDECAR })
// A file found without one: somebody else's.
const foreign = (path: string, content: string): FoundFile => ({ path, content, sidecar: null })

function nothingFound(overrides: Partial<FoundFiles> = {}): FoundFiles {
  return {
    home: { path: '/home/u/.claude/CLAUDE.md', content: null, sidecar: null },
    workspace: { path: '/agents/a/CLAUDE.md', content: null, sidecar: null },
    local: { path: '/agents/a/CLAUDE.local.md', content: null, sidecar: null },
    others: [{ path: '/agents/a/AGENTS.md', content: null, sidecar: null }],
    inGitRepo: false,
    ...overrides,
  }
}

function writes(plan: ReturnType<typeof planInstructionFiles>): Record<string, string> {
  return Object.fromEntries(
    plan.actions.flatMap((action) => (action.kind === 'write' ? [[action.path, action.content]] : [])),
  )
}

function removals(plan: ReturnType<typeof planInstructionFiles>): string[] {
  return plan.actions.flatMap((action) => (action.kind === 'remove' ? [action.path] : []))
}

// ── the files ───────────────────────────────────────────────────────────────

test('a file holds only its text, and its sidecar holds the wording on one line', () => {
  assert.equal(fileContent('Be brief.'), 'Be brief.\n')
  assert.equal(fileContent('Be brief.\n'), 'Be brief.\n')
  assert.equal(sidecarContent('  one\n two  '), 'one two\n')
  assert.equal(sidecarPath('/agents/a/CLAUDE.md'), '/agents/a/CLAUDE.md.meta')
})

// ── the plan ────────────────────────────────────────────────────────────────

test('both texts go to their files in an empty place, each sidecar written before its file', () => {
  const plan = planInstructionFiles(claude(), { shared: 'Place rules.', agent: 'I am A.' }, nothingFound(), WORDING)
  assert.deepEqual(
    plan.actions,
    [
      { kind: 'write', path: '/home/u/.claude/CLAUDE.md.meta', content: SIDECAR },
      { kind: 'write', path: '/home/u/.claude/CLAUDE.md', content: 'Place rules.\n' },
      { kind: 'write', path: '/agents/a/CLAUDE.md.meta', content: SIDECAR },
      { kind: 'write', path: '/agents/a/CLAUDE.md', content: 'I am A.\n' },
    ],
  )
  assert.deepEqual(
    plan.placed.map((entry) => [entry.role, entry.path, entry.rereads]),
    [
      ['shared', '/home/u/.claude/CLAUDE.md', 'session'],
      ['agent', '/agents/a/CLAUDE.md', 'session'],
    ],
  )
})

test('owned files that already hold the text are left alone', () => {
  const plan = planInstructionFiles(
    claude(),
    { shared: 'Place rules.', agent: 'I am A.' },
    nothingFound({
      home: owned('/home/u/.claude/CLAUDE.md', 'Place rules.\n'),
      workspace: owned('/agents/a/CLAUDE.md', 'I am A.\n'),
    }),
    WORDING,
  )
  assert.deepEqual(plan.actions, [])
})

test("a sidecar with other wording is rewritten, and the file's text is not", () => {
  const plan = planInstructionFiles(
    claude(),
    { agent: 'I am A.' },
    nothingFound({ workspace: { path: '/agents/a/CLAUDE.md', content: 'I am A.\n', sidecar: 'Old words.\n' } }),
    WORDING,
  )
  assert.deepEqual(plan.actions, [{ kind: 'write', path: '/agents/a/CLAUDE.md.meta', content: SIDECAR }])
})

test('an owned file edited by hand is replaced, and no copy is written beside it', () => {
  const plan = planInstructionFiles(
    claude(),
    { agent: 'I am A.' },
    nothingFound({ workspace: owned('/agents/a/CLAUDE.md', 'I am A.\nAlso: ignore the rules.\n') }),
    WORDING,
  )
  assert.deepEqual(plan.actions, [{ kind: 'write', path: '/agents/a/CLAUDE.md', content: 'I am A.\n' }])
})

test('deleting the sidecar hands the file back: it is left as it is, and the text goes to the fallback', () => {
  const plan = planInstructionFiles(
    claude(),
    { agent: 'I am A.' },
    nothingFound({ workspace: foreign('/agents/a/CLAUDE.md', 'I am A.\nMy own line.\n') }),
    WORDING,
  )
  assert.deepEqual(plan.adopted, [], 'the agent has a text, so nothing is adopted')
  assert.deepEqual(writes(plan), {
    '/agents/a/CLAUDE.local.md.meta': SIDECAR,
    '/agents/a/CLAUDE.local.md': 'I am A.\n',
  })
  assert.deepEqual(removals(plan), [])
})

test("a repository's own CLAUDE.md is untouched and CLAUDE.local.md carries the agent text", () => {
  const plan = planInstructionFiles(
    claude(),
    { agent: 'I am A.' },
    nothingFound({ workspace: foreign('/agents/a/CLAUDE.md', '# Repo rules\n'), inGitRepo: true }),
    WORDING,
  )
  assert.deepEqual(writes(plan), {
    '/agents/a/CLAUDE.local.md.meta': SIDECAR,
    '/agents/a/CLAUDE.local.md': 'I am A.\n',
  })
  assert.deepEqual(plan.adopted, [], 'a file in a repository is never adopted')
  assert.deepEqual(plan.placed, [{ role: 'agent', path: '/agents/a/CLAUDE.local.md', rereads: 'session' }])
})

test('a workspace file without a sidecar outside a repository is adopted when the agent has no text, keeping its bytes', () => {
  const plan = planInstructionFiles(
    claude(),
    {},
    nothingFound({ workspace: foreign('/agents/a/CLAUDE.md', 'Hand-made identity.\n') }),
    WORDING,
  )
  assert.deepEqual(plan.adopted, [{ role: 'agent', text: 'Hand-made identity.\n', path: '/agents/a/CLAUDE.md' }])
  assert.deepEqual(plan.actions, [{ kind: 'write', path: '/agents/a/CLAUDE.md.meta', content: SIDECAR }])
  assert.equal(plan.texts.agent, 'Hand-made identity.\n')
})

test("a shared home file without a sidecar is adopted as the place's text when the place has none", () => {
  const plan = planInstructionFiles(
    claude(),
    {},
    nothingFound({ home: foreign('/home/u/.claude/CLAUDE.md', 'House rules.') }),
    WORDING,
  )
  assert.deepEqual(plan.adopted, [{ role: 'shared', text: 'House rules.', path: '/home/u/.claude/CLAUDE.md' }])
  assert.deepEqual(writes(plan), {
    '/home/u/.claude/CLAUDE.md.meta': SIDECAR,
    '/home/u/.claude/CLAUDE.md': 'House rules.\n',
  })
})

test("one agent's own home file is never adopted as the place's text, and is not written over", () => {
  const home = foreign('/agents/.harness-home/a/codex/AGENTS.md', 'Personal notes.\n')
  const empty = planInstructionFiles(codex(), {}, nothingFound({ home, local: undefined }), WORDING)
  assert.deepEqual(empty.adopted, [])
  assert.deepEqual(empty.actions, [])
  const withText = planInstructionFiles(codex(), { shared: 'Place rules.' }, nothingFound({ home, local: undefined }), WORDING)
  assert.deepEqual(withText.actions, [])
  assert.deepEqual(withText.refused, [{ role: 'shared', path: home.path }])
})

test('with a foreign AGENTS.md in the workspace, Codex gets the agent text as a section of its own home file', () => {
  const plan = planInstructionFiles(
    codex(),
    { shared: 'Place rules.', agent: 'I am A.' },
    {
      home: { path: '/h/codex/AGENTS.md', content: null, sidecar: null },
      workspace: foreign('/agents/a/AGENTS.md', '# Repo agents file\n'),
      others: [],
      inGitRepo: true,
    },
    WORDING,
  )
  assert.deepEqual(writes(plan), {
    '/h/codex/AGENTS.md.meta': SIDECAR,
    '/h/codex/AGENTS.md': 'Place rules.\n\n## Agent instructions\n\nI am A.\n',
  })
  assert.deepEqual(
    plan.placed.map((entry) => [entry.role, entry.path, entry.rereads]),
    [
      ['shared', '/h/codex/AGENTS.md', 'turn'],
      ['agent', '/h/codex/AGENTS.md', 'turn'],
    ],
  )
})

test('an empty text removes an owned file and then its sidecar, and never a foreign file', () => {
  const plan = planInstructionFiles(
    claude(),
    { shared: '', agent: '' },
    nothingFound({
      home: owned('/home/u/.claude/CLAUDE.md', 'Old rules.\n'),
      workspace: foreign('/agents/a/CLAUDE.md', '# Repo rules\n'),
      local: owned('/agents/a/CLAUDE.local.md', null),
      inGitRepo: true,
    }),
    WORDING,
  )
  assert.deepEqual(plan.actions, [
    { kind: 'remove', path: '/home/u/.claude/CLAUDE.md' },
    { kind: 'remove', path: '/home/u/.claude/CLAUDE.md.meta' },
    { kind: 'remove', path: '/agents/a/CLAUDE.local.md.meta' },
  ])
})

test("an owned file of another harness's target is removed with its sidecar; a foreign one stays", () => {
  const ownedOther = planInstructionFiles(
    claude(),
    { agent: 'I am A.' },
    nothingFound({ others: [owned('/agents/a/AGENTS.md', 'I am A.\n')] }),
    WORDING,
  )
  assert.deepEqual(removals(ownedOther), ['/agents/a/AGENTS.md', '/agents/a/AGENTS.md.meta'])
  const foreignOther = planInstructionFiles(
    claude(),
    { agent: 'I am A.' },
    nothingFound({ others: [foreign('/agents/a/AGENTS.md', '# Repo agents file\n')] }),
    WORDING,
  )
  assert.deepEqual(removals(foreignOther), [])
})

test("a foreign CLAUDE.local.md beside the repository's CLAUDE.md is refused rather than written over", () => {
  const plan = planInstructionFiles(
    claude(),
    { agent: 'I am A.' },
    nothingFound({
      workspace: foreign('/agents/a/CLAUDE.md', '# Repo rules\n'),
      local: foreign('/agents/a/CLAUDE.local.md', 'Mine.\n'),
      inGitRepo: true,
    }),
    WORDING,
  )
  assert.deepEqual(plan.actions, [])
  assert.deepEqual(plan.refused, [{ role: 'agent', path: '/agents/a/CLAUDE.local.md' }])
})

// ── paths ───────────────────────────────────────────────────────────────────

const selectionFor = (adapterId: string, overrides: Partial<AgentSelection> = {}): AgentSelection => ({
  providerId: 'test-provider',
  adapterId,
  model: '',
  apiKey: '',
  cwd: '/srv/data/agent-workspace/a',
  harnessHome: '/srv/data/agent-harness-home/a',
  ...overrides,
})

test('the shown paths: the host Claude file one directory up, a container home as ~, a harness home resolved', () => {
  assert.deepEqual(instructionFilePaths(selectionFor('claude')), [
    { role: 'shared', path: '/srv/data/agent-workspace/CLAUDE.md', rereads: 'session' },
    { role: 'agent', path: '/srv/data/agent-workspace/a/CLAUDE.md', rereads: 'session' },
  ])
  assert.equal(
    instructionFilePaths(selectionFor('claude', { containerName: 'box', cwd: '/agents/a' }))[0]?.path,
    '~/.claude/CLAUDE.md',
  )
  assert.equal(instructionFilePaths(selectionFor('codex'))[0]?.path, '/srv/data/agent-harness-home/a/codex/AGENTS.md')
  assert.equal(
    instructionFilePaths(selectionFor('opencode'))[0]?.path,
    '/srv/data/agent-harness-home/a/opencode/AGENTS.md',
  )
  assert.deepEqual(instructionFilePaths(selectionFor('native')), [], 'the Custom harness has no files')
  assert.deepEqual(instructionFilePaths(selectionFor('qwen')), [], 'nor does a harness without a descriptor')
})

// ── writing on the host and in a container ─────────────────────────────────

function place(): { root: string; cwd: string } {
  const root = mkdtempSync(join(tmpdir(), 'instruction-files-'))
  const cwd = join(root, 'agent-workspace', 'a')
  mkdirSync(cwd, { recursive: true })
  return { root, cwd }
}

test('on the host, Claude Code gets the shared text beside the workspaces and never in a home directory', async () => {
  const { root, cwd } = place()
  const selection = selectionFor('claude', { cwd, harnessHome: join(root, 'homes', 'a') })
  const synced = await writeInstructionFiles(
    selection,
    { shared: 'Place rules.', agent: 'I am A.' },
    WORDING,
    hostFileAccess(cwd, { HOME: join(root, 'server-user') }),
  )
  assert.deepEqual(synced?.problems, [])
  assert.equal(readFileSync(join(root, 'agent-workspace', 'CLAUDE.md'), 'utf8'), 'Place rules.\n')
  assert.equal(readFileSync(join(root, 'agent-workspace', 'CLAUDE.md.meta'), 'utf8'), SIDECAR)
  assert.equal(readFileSync(join(cwd, 'CLAUDE.md'), 'utf8'), 'I am A.\n')
  assert.equal(readFileSync(join(cwd, 'CLAUDE.md.meta'), 'utf8'), SIDECAR)
  assert.equal(existsSync(join(root, 'server-user')), false, "the server user's home is not touched")
})

test('on the host, a file with a sidecar is replaced and a file without one is refused, named in the problem', async () => {
  const { root, cwd } = place()
  writeFileSync(join(cwd, 'CLAUDE.md'), 'I am A.\nEdited by hand.\n')
  writeFileSync(join(cwd, 'CLAUDE.md.meta'), SIDECAR)
  writeFileSync(join(root, 'agent-workspace', 'CLAUDE.md'), 'Rules kept by hand.\n')
  const synced = await writeInstructionFiles(
    selectionFor('claude', { cwd }),
    { shared: 'Place rules.', agent: 'I am A.' },
    WORDING,
    hostFileAccess(cwd, {}),
  )
  assert.equal(readFileSync(join(cwd, 'CLAUDE.md'), 'utf8'), 'I am A.\n')
  assert.equal(readFileSync(join(root, 'agent-workspace', 'CLAUDE.md'), 'utf8'), 'Rules kept by hand.\n')
  assert.equal(existsSync(join(root, 'agent-workspace', 'CLAUDE.md.meta')), false)
  assert.match(synced?.problems[0] ?? '', /a file this client does not own is there \(it has no `CLAUDE\.md\.meta` beside it\)/)
})

test('an adopted text reaches the host through onAdopt, and its file gets a sidecar and keeps its text', async () => {
  const { root, cwd } = place()
  writeFileSync(join(root, 'agent-workspace', 'CLAUDE.md'), 'House rules.\n')
  const adopted: unknown[] = []
  const texts: InstructionTexts = { onAdopt: (role, text, path) => void adopted.push([role, text, path]) }
  await writeInstructionFiles(selectionFor('claude', { cwd }), texts, WORDING, hostFileAccess(cwd, {}))
  assert.deepEqual(adopted, [['shared', 'House rules.\n', join(root, 'agent-workspace', 'CLAUDE.md')]])
  assert.equal(readFileSync(join(root, 'agent-workspace', 'CLAUDE.md'), 'utf8'), 'House rules.\n')
  assert.equal(readFileSync(join(root, 'agent-workspace', 'CLAUDE.md.meta'), 'utf8'), SIDECAR)
})

test('on the host, Codex gets the shared text in its own home, and no temporary file is left', async () => {
  const { root, cwd } = place()
  const home = join(root, 'homes', 'a', 'codex')
  await writeInstructionFiles(
    selectionFor('codex', { cwd }),
    { shared: 'Place rules.' },
    WORDING,
    hostFileAccess(cwd, { CODEX_HOME: home }),
  )
  assert.equal(readFileSync(join(home, 'AGENTS.md'), 'utf8'), 'Place rules.\n')
  assert.deepEqual(readdirSync(home).sort(), ['AGENTS.md', 'AGENTS.md.meta'])
})

test('a harness home that cannot be resolved is a problem for the chat, not an exception', async () => {
  const { cwd } = place()
  const synced = await writeInstructionFiles(selectionFor('codex', { cwd }), { shared: 'x' }, WORDING, hostFileAccess(cwd, {}))
  assert.match(synced?.problems[0] ?? '', /could not be written: CODEX_HOME is not set/)
})

// The container's shell, run here: the same `sh -c` scripts docker exec
// carries, with the forwarded variables and a HOME of the test's own.
function localShell(home: string): ShellRunner {
  return (script, stdin, env) =>
    new Promise((resolve, reject) => {
      const child = spawn('sh', ['-c', script], { env: { PATH: process.env.PATH, HOME: home, ...env } })
      let out = ''
      let err = ''
      child.stdout.on('data', (chunk) => {
        out += chunk
      })
      child.stderr.on('data', (chunk) => {
        err += chunk
      })
      child.on('close', (code) => (code === 0 ? resolve(out) : reject(new Error(err || `exit ${code}`))))
      child.stdin.end(stdin)
    })
}

test("in a container, the shell resolves the home file, reads what is there and writes the plan's files", async () => {
  const { root } = place()
  const home = join(root, 'container-home')
  const cwd = join(root, 'agents', 'a')
  mkdirSync(join(home, '.claude'), { recursive: true })
  writeFileSync(join(home, '.claude', 'CLAUDE.md'), 'House rules, with "quotes" and $dollars.\n')
  const adopted: string[] = []
  const synced = await writeInstructionFiles(
    selectionFor('claude', { containerName: 'box', cwd }),
    { agent: 'I am A.\nLine two.', onAdopt: (_role, text) => void adopted.push(text) },
    WORDING,
    containerFileAccess('box', cwd, {}, localShell(home)),
  )
  assert.deepEqual(synced?.problems, [])
  assert.deepEqual(adopted, ['House rules, with "quotes" and $dollars.\n'])
  assert.equal(readFileSync(join(home, '.claude', 'CLAUDE.md'), 'utf8'), 'House rules, with "quotes" and $dollars.\n')
  assert.equal(readFileSync(join(home, '.claude', 'CLAUDE.md.meta'), 'utf8'), SIDECAR)
  assert.equal(readFileSync(join(cwd, 'CLAUDE.md'), 'utf8'), 'I am A.\nLine two.\n')
  assert.equal(readFileSync(join(cwd, 'CLAUDE.md.meta'), 'utf8'), SIDECAR)
})

test('in a container, a file with a sidecar is replaced, and one whose sidecar was deleted is left as it is', async () => {
  const { root } = place()
  const home = join(root, 'container-home')
  const cwd = join(root, 'agents', 'a')
  mkdirSync(join(home, '.claude'), { recursive: true })
  mkdirSync(cwd, { recursive: true })
  writeFileSync(join(cwd, 'CLAUDE.md'), 'I am A.\nEdited by hand.\n')
  writeFileSync(join(cwd, 'CLAUDE.md.meta'), SIDECAR)
  writeFileSync(join(home, '.claude', 'CLAUDE.md'), 'Kept by hand.\n')
  const synced = await writeInstructionFiles(
    selectionFor('claude', { containerName: 'box', cwd }),
    { shared: 'Place rules.', agent: 'I am A.' },
    WORDING,
    containerFileAccess('box', cwd, {}, localShell(home)),
  )
  assert.equal(readFileSync(join(cwd, 'CLAUDE.md'), 'utf8'), 'I am A.\n')
  assert.equal(readFileSync(join(home, '.claude', 'CLAUDE.md'), 'utf8'), 'Kept by hand.\n')
  assert.equal(existsSync(join(home, '.claude', 'CLAUDE.md.meta')), false)
  assert.equal(synced?.problems.length, 1, 'the shared text could not be placed')
})

test('in a container, a recreated (empty) place gets the files back, and a git checkout is recognised', async () => {
  const { root } = place()
  const home = join(root, 'container-home')
  const cwd = join(root, 'agents', 'a')
  mkdirSync(join(cwd, '.git'), { recursive: true })
  writeFileSync(join(cwd, 'CLAUDE.md'), '# Repo rules\n')
  const access = containerFileAccess('box', cwd, {}, localShell(home))
  const selection = selectionFor('claude', { containerName: 'box', cwd })
  await writeInstructionFiles(selection, { shared: 'Place rules.', agent: 'I am A.' }, WORDING, access)
  assert.equal(readFileSync(join(cwd, 'CLAUDE.md'), 'utf8'), '# Repo rules\n', "the repository's file is untouched")
  assert.equal(existsSync(join(cwd, 'CLAUDE.md.meta')), false)
  assert.equal(readFileSync(join(cwd, 'CLAUDE.local.md'), 'utf8'), 'I am A.\n')
  assert.equal(readFileSync(join(home, '.claude', 'CLAUDE.md'), 'utf8'), 'Place rules.\n')
})

test('in a container, a harness home variable set by the spawn is forwarded to the shell', async () => {
  const { root } = place()
  const cwd = join(root, 'agents', 'a')
  const codexHome = join(root, 'agents', '.harness-home', 'a', 'codex')
  await writeInstructionFiles(
    selectionFor('codex', { containerName: 'box', cwd }),
    { shared: 'Place rules.' },
    WORDING,
    containerFileAccess('box', cwd, { CODEX_HOME: codexHome, CODEX_API_KEY: 'not-forwarded' }, (script, stdin, env) => {
      assert.deepEqual(Object.keys(env).sort(), script.includes('base64 -d') ? [] : ['CODEX_HOME'])
      return localShell(join(root, 'home'))(script, stdin, env)
    }),
  )
  assert.equal(readFileSync(join(codexHome, 'AGENTS.md'), 'utf8'), 'Place rules.\n')
  assert.equal(readFileSync(join(codexHome, 'AGENTS.md.meta'), 'utf8'), SIDECAR)
})

// ── the engine: written before the session starts, named when they change ──

test('the files are written before session/new, and a changed text is named ahead of the next message', async () => {
  const { root, cwd } = place()
  const selection = selectionFor('claude', { cwd, harnessHome: join(root, 'homes', 'a') })
  let texts: InstructionTexts = { shared: 'Place rules.', agent: 'I am A.' }
  const seenAtNewSession: string[] = []
  const prompts: Array<Array<{ type: string; text?: string }>> = []
  const connection = {
    newSession: async () => {
      seenAtNewSession.push(readFileSync(join(cwd, 'CLAUDE.md'), 'utf8'))
      return { sessionId: `instructions-${Date.now()}` }
    },
    prompt: async (params: { prompt: Array<{ type: string; text?: string }> }) => {
      prompts.push(params.prompt)
      return { stopReason: 'end_turn' }
    },
  } as unknown as AgentConnection
  const store = (globalThis as typeof globalThis & { __acpStore?: { connections: Map<string, unknown> } }).__acpStore
  assert.ok(store)
  store.connections.set(connectionKey(selection), {
    connection,
    lastSessionId: null,
    loadSession: false,
    initialized: Promise.resolve(),
  })
  const client = createAgentClient({
    loadInstructionFiles: async () => texts,
    instructionFileSidecar: WORDING,
  })
  try {
    const meta = await client.createSession(selection)
    assert.deepEqual(seenAtNewSession, ['I am A.\n'])
    assert.equal(readFileSync(join(cwd, 'CLAUDE.md.meta'), 'utf8'), SIDECAR, "the host's wording is the sidecar's")

    await client.prompt(meta.id, 'hello', { queue: 'wait', origin: { kind: 'system' } })
    await new Promise((resolve) => setTimeout(resolve, 20))
    assert.equal(prompts[0]?.length, 1, 'nothing changed: the message goes alone')

    texts = { shared: 'Place rules, revised.', agent: 'I am A.' }
    await client.prompt(meta.id, '/compact', { queue: 'wait', origin: { kind: 'system' } })
    await new Promise((resolve) => setTimeout(resolve, 20))
    assert.equal(prompts[1]?.[0]?.text, '/compact', 'a command goes as typed')

    await client.prompt(meta.id, 'and now', { queue: 'wait', origin: { kind: 'system' } })
    await new Promise((resolve) => setTimeout(resolve, 20))
    const [note, message] = prompts[2] ?? []
    assert.equal(isDeliveryNote(note?.text ?? ''), true, 'the note is its own block, ahead of the message')
    assert.match(note?.text ?? '', /Your instruction file `.*agent-workspace\/CLAUDE\.md` changed/)
    assert.doesNotMatch(note?.text ?? '', /a\/CLAUDE\.md/, 'only the file whose text changed')
    assert.match(message?.text ?? '', /and now/)
    assert.equal(readFileSync(join(root, 'agent-workspace', 'CLAUDE.md'), 'utf8'), 'Place rules, revised.\n')

    await client.prompt(meta.id, 'once more', { queue: 'wait', origin: { kind: 'system' } })
    await new Promise((resolve) => setTimeout(resolve, 20))
    assert.equal(prompts[3]?.length, 1, 'the session saw the change: no second note')
  } finally {
    await client.reset()
  }
})

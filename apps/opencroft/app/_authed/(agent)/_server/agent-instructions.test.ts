// Exercises the real database (embedded PGlite by default) — see @opencroft/db's
// test-env. An agent's two texts: its own on its node, its place's shared one
// in a Setting row; the hook agent-client reads them through, and the read and
// write API the MCP tools and the server module answer from.
import '@opencroft/db/test-env'

import assert from 'node:assert/strict'
import test from 'node:test'

import { db, groupChat, groupChatMember } from '@opencroft/db'
import type { AgentSelection } from 'agent-client/types'

import { readAgentInstructions, writeAgentInstructions } from '@/app/_authed/(agent)/_server/agent-instructions'
import {
  findAgentInstructionNode,
  instructionPlace,
  loadInstructionTexts,
  readSharedInstructions,
  writeSharedInstructions,
} from '@/app/_authed/(agent)/_server/instruction-store'
import { AGENT_NODE_TYPE } from '@/app/_authed/(agent)/_shared/agent-node-shape'
import { updateNodeData } from '@/app/_authed/(extension-runtime)/_server/node-data'
import { handlers } from '@/app/_authed/(mcp)/_server/agent-instruction-tools'
import { slug } from '@/app/_authed/(server)/_server/types'
import { getSpacesRegistry } from '@/app/_authed/(space)/_server/store'

// Agents on a terminal of the test's own, so each test's place is its own.
async function agentsIn(
  terminal: string | undefined,
  agents: Array<{ name: string; adapterId?: string; workspaceInstructions?: string; systemPrompt?: string }>,
): Promise<string[]> {
  const registry = getSpacesRegistry()
  await registry.ensureLoaded()
  const space = `agent-instructions-test-${crypto.randomUUID()}`
  const ids = agents.map(() => crypto.randomUUID())
  await registry.create(space, space, {
    nodes: agents.map((data, index) => ({
      id: ids[index],
      type: AGENT_NODE_TYPE,
      position: { x: index * 200, y: 0 },
      data: { ...data, ...(terminal ? { terminal, terminalFolder: `/agents/${slug(data.name)}` } : {}) },
    })),
    edges: [],
  })
  return ids
}

const unique = (what: string) => `${what} ${crypto.randomUUID().slice(0, 8)}`

function selectionFor(name: string, terminal?: string): AgentSelection {
  return {
    providerId: '',
    adapterId: 'claude',
    model: '',
    apiKey: '',
    cwd: '/agents/x',
    mcpIdentity: slug(name),
    shell: terminal,
  }
}

test('a place is its terminal, or the host', () => {
  assert.equal(instructionPlace({ terminal: 'box/terminal' }), 'terminal:box/terminal')
  assert.equal(instructionPlace({ terminal: ' ' }), 'host')
  assert.equal(instructionPlace({}), 'host')
})

test('a shared write applies only at the version it read, so a second writer cannot overwrite it unseen', async () => {
  const place = instructionPlace({ terminal: unique('box/terminal') })
  assert.deepEqual(await readSharedInstructions(place), { text: '', version: 0 })
  const first = await writeSharedInstructions(place, 'One.', { updatedBy: 'A' }, 0)
  assert.equal(first?.version, 1)
  assert.equal(await writeSharedInstructions(place, 'Two.', { updatedBy: 'B' }, 0), null, 'the stale version loses')
  const read = await readSharedInstructions(place)
  assert.equal(read.text, 'One.')
  assert.equal(read.updatedBy, 'A')
})

test("the hook answers the agent's own text and its place's shared text", async () => {
  const container = unique('box/terminal')
  const name = unique('Hook Agent')
  await agentsIn(container, [{ name, workspaceInstructions: 'I am the hook agent.' }])
  await writeSharedInstructions(instructionPlace({ terminal: container }), 'House rules.', {}, 0)
  const texts = await loadInstructionTexts(selectionFor(name, container))
  assert.equal(texts?.agent, 'I am the hook agent.')
  assert.equal(texts?.shared, 'House rules.')
  assert.equal(await loadInstructionTexts(selectionFor(unique('Nobody'))), undefined, 'no agent, nothing to write')
})

test('an adopted text is stored only while its role is still empty', async () => {
  const container = unique('box/terminal')
  const place = instructionPlace({ terminal: container })
  const name = unique('Adopting Agent')
  const [nodeId] = await agentsIn(container, [{ name }])
  const texts = await loadInstructionTexts(selectionFor(name, container))
  await texts?.onAdopt?.('shared', 'Found in the home file.\n', '/home/node/.claude/CLAUDE.md')
  await texts?.onAdopt?.('agent', 'Found in the workspace.\n', '/agents/x/CLAUDE.md')
  const stored = await readSharedInstructions(place)
  assert.equal(stored.text, 'Found in the home file.\n')
  assert.equal(stored.adoptedFrom, '/home/node/.claude/CLAUDE.md')
  assert.equal((await findAgentInstructionNode(nodeId))?.data.workspaceInstructions, 'Found in the workspace.\n')

  await texts?.onAdopt?.('shared', 'A later file.\n', '/elsewhere')
  await texts?.onAdopt?.('agent', 'A later file.\n', '/elsewhere')
  assert.equal((await readSharedInstructions(place)).text, 'Found in the home file.\n', 'a stored text wins')
  assert.equal((await findAgentInstructionNode(nodeId))?.data.workspaceInstructions, 'Found in the workspace.\n')
})

test('the read lists the shared text first, with everyone in the place whose harness reads it', async () => {
  const container = unique('box/terminal')
  const [a] = await agentsIn(container, [
    { name: unique('Alpha'), workspaceInstructions: 'I am Alpha.' },
    { name: unique('Beta'), adapterId: 'codex' },
    { name: unique('Gamma'), adapterId: 'qwen' },
  ])
  await writeSharedInstructions(instructionPlace({ terminal: container }), 'House rules.', {}, 0)
  const read = await readAgentInstructions(a)
  assert.equal(read.harness, 'Claude Code')
  assert.deepEqual(
    read.files.map((file) => [file.role, file.path, file.rereads, file.text]),
    [
      ['shared', '~/.claude/CLAUDE.md', 'session', 'House rules.'],
      ['agent', `/agents/${slug(read.agent.name)}/CLAUDE.md`, 'session', 'I am Alpha.'],
    ],
  )
  assert.equal(read.files[0]?.sharedWith?.length, 2, 'Alpha and Beta; the harness without files is not counted')
  assert.equal(read.files[0]?.place, `terminal:${container}`)
})

test('the Custom harness has its system prompt, and a harness without files has nothing', async () => {
  const [custom, qwen] = await agentsIn(undefined, [
    { name: unique('Custom'), adapterId: 'native', systemPrompt: 'You are terse.' },
    { name: unique('Qwen'), adapterId: 'qwen' },
  ])
  assert.deepEqual((await readAgentInstructions(custom)).files, [{ role: 'system-prompt', text: 'You are terse.' }])
  assert.deepEqual((await readAgentInstructions(qwen)).files, [])
})

test("a write replaces the agent's text, the system prompt or the shared text, and refuses a role the harness does not read", async () => {
  const container = unique('box/terminal')
  const [claude, custom, other] = await agentsIn(container, [
    { name: unique('Writer') },
    { name: unique('Custom Writer'), adapterId: 'native' },
    { name: unique('Neighbour') },
  ])
  await writeAgentInstructions(claude, 'agent', 'I write.')
  assert.equal((await findAgentInstructionNode(claude))?.data.workspaceInstructions, 'I write.')
  const shared = await writeAgentInstructions(claude, 'shared', 'Everyone here.', { updatedBy: 'Tester' })
  assert.equal(shared.sharedWith?.length, 2, 'both Claude Code agents in the place read it')
  assert.equal((await readSharedInstructions(instructionPlace({ terminal: container }))).updatedBy, 'Tester')
  assert.equal((await readAgentInstructions(other)).files[0]?.text, 'Everyone here.', 'the neighbour reads it too')
  await writeAgentInstructions(custom, 'system-prompt', 'Be kind.')
  assert.equal((await findAgentInstructionNode(custom))?.data.systemPrompt, 'Be kind.')
  await assert.rejects(writeAgentInstructions(custom, 'agent', 'x'), /system prompt: write role "system-prompt"/)
  await assert.rejects(writeAgentInstructions(claude, 'system-prompt', 'x'), /not a system prompt/)
})

test('a shared write at a stale version writes nothing and answers the text that is there now', async () => {
  const container = unique('box/terminal')
  const [first, second] = await agentsIn(container, [{ name: unique('First') }, { name: unique('Second') }])
  const place = instructionPlace({ terminal: container })
  const read = (await readAgentInstructions(first)).files[0]
  assert.equal(read?.place, place)
  assert.equal(read?.version, 0)

  const saved = await writeAgentInstructions(second, 'shared', 'Saved first.', {
    updatedBy: 'Other',
    expected: { place, version: 0 },
  })
  assert.equal(saved.conflict, undefined)
  assert.equal(saved.version, 1)

  const late = await writeAgentInstructions(first, 'shared', 'Saved late.', { expected: { place, version: 0 } })
  assert.deepEqual(late.conflict, { text: 'Saved first.', version: 1, updatedBy: 'Other' })
  assert.equal((await readAgentInstructions(first)).files[0]?.text, 'Saved first.', 'the late write changed nothing')

  const over = await writeAgentInstructions(first, 'shared', 'Saved late.', { expected: { place, version: 1 } })
  assert.equal(over.version, 2, 'at the version the conflict answered, it applies')
  assert.equal((await readAgentInstructions(second)).files[0]?.text, 'Saved late.')
})

test('a shared write read in one place is refused once the agent has moved to another', async () => {
  const from = unique('box/terminal')
  const to = unique('box/terminal')
  const [agent] = await agentsIn(from, [{ name: unique('Mover') }])
  const read = (await readAgentInstructions(agent)).files[0]
  assert.equal(read?.place, instructionPlace({ terminal: from }))

  const node = await findAgentInstructionNode(agent)
  assert.ok(node)
  await updateNodeData(node.spaceSlug, agent, (prev) => ({ ...prev, terminal: to }))

  // Both rows are at version 0, so only the place tells the write it read the other row.
  await assert.rejects(
    writeAgentInstructions(agent, 'shared', 'Meant for the first box.', {
      expected: { place: instructionPlace({ terminal: from }), version: 0 },
    }),
    /nothing was written/,
  )
  assert.deepEqual(await readSharedInstructions(instructionPlace({ terminal: to })), { text: '', version: 0 })
  assert.deepEqual(await readSharedInstructions(instructionPlace({ terminal: from })), { text: '', version: 0 })
})

test('the read names the chats the agent is in, whose topic and pins reach it', async () => {
  const [agent, loner] = await agentsIn(undefined, [{ name: unique('Chatty') }, { name: unique('Loner') }])
  const names = ['Zeta room', 'Alpha room']
  for (const name of names) {
    const [chat] = await db
      .insert(groupChat)
      .values({ slug: slug(unique(name)), name, topic: name })
      .returning()
    await db.insert(groupChatMember).values({ groupChatId: chat.id, principalType: 'agent', agentNodeId: agent })
  }
  assert.deepEqual(
    (await readAgentInstructions(agent)).chats.map((chat) => chat.name),
    ['Alpha room', 'Zeta room'],
  )
  assert.deepEqual((await readAgentInstructions(loner)).chats, [])
})

test('the MCP tools resolve an agent by name, and refuse a name two agents share', async () => {
  const name = unique('Named')
  await agentsIn(undefined, [{ name, workspaceInstructions: 'By name.' }])
  const read = await handlers.agent_instructions_read({ agent: name }, { agent: null })
  const parsed = JSON.parse((read.content as Array<{ text: string }>)[0].text) as { files: Array<{ text: string }> }
  assert.equal(parsed.files.at(-1)?.text, 'By name.')

  const twin = unique('Twin')
  await agentsIn(undefined, [{ name: twin }, { name: twin }])
  await assert.rejects(handlers.agent_instructions_read({ agent: twin }, { agent: null }), {
    code: -32602,
    message: /2 agents are named/,
  })
  await assert.rejects(
    handlers.agent_instructions_write({ agent: name, role: 'everything', text: 'x' }, { agent: null }),
    { code: -32602, message: /role must be one of/ },
  )
})

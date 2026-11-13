// The startup pass that moves Agent Instruction nodes into their agents'
// own texts, over real space graphs.
//
// The registry loads its database on first use, so the throwaway environment
// has to be in place first.
import '@opencroft/db/test-env'

import assert from 'node:assert/strict'
import test from 'node:test'

import {
  appendSection,
  INSTRUCTION_NODE_TYPE,
  instructionFieldOf,
  instructionSection,
  migrateInstructionNodes,
} from '@/app/_authed/(agent)/_server/instruction-node-migration'
import { AGENT_NODE_TYPE } from '@/app/_authed/(agent)/_shared/agent-node-shape'
import { SUBGRAPH_TYPE } from '@/app/_authed/(extension-runtime)/_builtin/core/src/nodes/subgraph-shared'
import { resolveGraph } from '@/app/_authed/(space)/_server/resolve-graph'
import { getSpacesRegistry } from '@/app/_authed/(space)/_server/store'
import type { GraphData } from '@/app/_authed/(space)/_server/types'

const at = { x: 0, y: 0 }

async function space(graph: GraphData): Promise<string> {
  const slug = `instruction-migration-${crypto.randomUUID()}`
  const registry = getSpacesRegistry()
  await registry.ensureLoaded()
  await registry.create(slug, slug, await resolveGraph(graph))
  return slug
}

function agent(id: string, data: Record<string, unknown> = {}, parentId?: string) {
  return { id, type: AGENT_NODE_TYPE, position: at, data: { name: id, ...data }, ...(parentId ? { parentId } : {}) }
}

function instruction(id: string, data: { name?: string; instruction?: string }, parentId?: string) {
  return { id, type: INSTRUCTION_NODE_TYPE, position: at, data, ...(parentId ? { parentId } : {}) }
}

function subgraph(id: string) {
  const port = { id: 'tone', label: 'Tone', handleType: INSTRUCTION_NODE_TYPE }
  return {
    id,
    type: SUBGRAPH_TYPE,
    position: { x: 400, y: 0 },
    data: { name: id, ports: { inputs: [port], outputs: [{ ...port, id: 'tone-out' }] } },
  }
}

function edge(id: string, source: string, sourceHandle: string, target: string, targetHandle: string) {
  return { id, source, sourceHandle, target, targetHandle }
}

function wire(id: string, from: string, to: string) {
  return edge(id, from, 'instruction-out', to, 'instructions-in')
}

function graphOf(slug: string) {
  const graphs = [...(getSpacesRegistry().getBySlug(slug)?.graphs.values() ?? [])]
  assert.ok(graphs.length > 0, `space ${slug} has a graph`)
  return {
    nodes: graphs.flatMap((g) => g.graph.nodes as { id: string; type: string; data?: Record<string, unknown> }[]),
    edges: graphs.flatMap((g) => g.graph.edges as { id: string; source: string; target: string }[]),
  }
}

function dataOf(slug: string, nodeId: string): Record<string, unknown> {
  const node = graphOf(slug).nodes.find((n) => n.id === nodeId)
  assert.ok(node, `node ${nodeId} is in ${slug}`)
  return node.data ?? {}
}

// Every space a test makes holds instruction nodes, and the pass runs over
// every space, so a test reads its own lines by its node ids.
function lineFor(lines: string[], nodeId: string): string {
  const matching = lines.filter((line) => line.includes(`(${nodeId})`))
  assert.equal(matching.length, 1, `one line names ${nodeId}, got: ${JSON.stringify(lines)}`)
  return matching[0] as string
}

test("a section goes after the agent's text, once", () => {
  const section = instructionSection('Tone', 'Answer in English.')
  assert.equal(section, '## Tone\n\nAnswer in English.')
  assert.equal(appendSection('', section), '## Tone\n\nAnswer in English.\n')
  assert.equal(appendSection('I review code.\n\n', section), 'I review code.\n\n## Tone\n\nAnswer in English.\n')
  const once = appendSection('I review code.', section)
  assert.equal(appendSection(once, section), once, 'a text holding the section is left as it is')
})

test('the text goes to the system prompt for a harness that takes one, else to the instruction file', () => {
  assert.deepEqual(instructionFieldOf({ adapterId: 'native' }), { field: 'systemPrompt', read: true })
  assert.deepEqual(instructionFieldOf({ adapterId: 'codex' }), { field: 'workspaceInstructions', read: true })
  assert.deepEqual(instructionFieldOf({}), { field: 'workspaceInstructions', read: true }, 'no adapter is Claude')
  assert.deepEqual(instructionFieldOf({ adapterId: 'qwen' }), { field: 'workspaceInstructions', read: false })
})

test("a wired node's text is appended to its agent's instructions under its name, and the node and edge go", async () => {
  const slug = await space({
    nodes: [
      agent('a1-agent', { workspaceInstructions: 'I review code.' }),
      instruction('a1-tone', { name: 'Tone', instruction: '  Answer in English.  ' }),
      instruction('a1-scope', { name: '', instruction: 'Stay on the task.' }),
    ],
    edges: [wire('a1-e1', 'a1-tone', 'a1-agent'), wire('a1-e2', 'a1-scope', 'a1-agent')],
  })
  const lines = await migrateInstructionNodes()

  assert.equal(
    dataOf(slug, 'a1-agent').workspaceInstructions,
    'I review code.\n\n## Tone\n\nAnswer in English.\n\n## Instruction\n\nStay on the task.\n',
  )
  const { nodes, edges } = graphOf(slug)
  assert.deepEqual(
    nodes.map((n) => n.id),
    ['a1-agent'],
  )
  assert.deepEqual(edges, [])
  assert.match(lineFor(lines, 'a1-tone'), /^moved "Tone" \(a1-tone\) in .* into a1-agent \(a1-agent\)'s instructions/)
  assert.match(lineFor(lines, 'a1-scope'), /^moved "Instruction" \(a1-scope\)/)
})

test('a node wired to two agents goes into both, a system prompt included', async () => {
  const slug = await space({
    nodes: [
      agent('b1-claude'),
      agent('b1-custom', { adapterId: 'native', systemPrompt: 'You are terse.' }),
      instruction('b1-tone', { name: 'Tone', instruction: 'Answer in English.' }),
    ],
    edges: [wire('b1-e1', 'b1-tone', 'b1-claude'), wire('b1-e2', 'b1-tone', 'b1-custom')],
  })
  const lines = await migrateInstructionNodes()

  assert.equal(dataOf(slug, 'b1-claude').workspaceInstructions, '## Tone\n\nAnswer in English.\n')
  assert.equal(dataOf(slug, 'b1-custom').systemPrompt, 'You are terse.\n\n## Tone\n\nAnswer in English.\n')
  assert.equal(dataOf(slug, 'b1-custom').workspaceInstructions, undefined)
  assert.match(
    lineFor(lines, 'b1-tone'),
    /b1-claude \(b1-claude\)'s instructions, b1-custom \(b1-custom\)'s system prompt/,
  )
})

test('a node wired through a subgraph port reaches the agent on the other side, in either direction', async () => {
  const into = await space({
    nodes: [
      instruction('s1-instr', { name: 'Tone', instruction: 'Into.' }),
      subgraph('s1-sub'),
      agent('s1-agent', {}, 's1-sub'),
    ],
    edges: [
      edge('s1-o', 's1-instr', 'instruction-out', 's1-sub', 'in-tone'),
      edge('s1-i', 's1-sub', 'in-tone', 's1-agent', 'instructions-in'),
    ],
  })
  const out = await space({
    nodes: [
      subgraph('s2-sub'),
      instruction('s2-instr', { name: 'Tone', instruction: 'Out.' }, 's2-sub'),
      agent('s2-agent'),
    ],
    edges: [
      edge('s2-i', 's2-instr', 'instruction-out', 's2-sub', 'out-tone-out'),
      edge('s2-o', 's2-sub', 'out-tone-out', 's2-agent', 'instructions-in'),
    ],
  })
  await migrateInstructionNodes()

  assert.equal(dataOf(into, 's1-agent').workspaceInstructions, '## Tone\n\nInto.\n')
  assert.equal(dataOf(out, 's2-agent').workspaceInstructions, '## Tone\n\nOut.\n')
  assert.deepEqual(
    graphOf(into).edges.map((e) => e.id),
    ['s1-i'],
    "the node's own edge goes; the one inside the subgraph stays",
  )
  assert.deepEqual(
    graphOf(out).edges.map((e) => e.id),
    ['s2-o'],
  )
})

test('a node wired to no agent, or holding no text, is deleted with a line saying so', async () => {
  const slug = await space({
    nodes: [
      agent('c1-agent', { workspaceInstructions: 'Mine.' }),
      instruction('c1-loose', { name: 'Loose', instruction: 'Nobody reads this.' }),
      instruction('c1-blank', { name: 'Blank', instruction: '   ' }),
    ],
    edges: [wire('c1-e', 'c1-blank', 'c1-agent')],
  })
  const lines = await migrateInstructionNodes()

  assert.deepEqual(
    graphOf(slug).nodes.map((n) => n.id),
    ['c1-agent'],
  )
  assert.equal(dataOf(slug, 'c1-agent').workspaceInstructions, 'Mine.', 'a blank node adds nothing')
  assert.equal(
    lineFor(lines, 'c1-loose'),
    `deleted "Loose" (c1-loose) in ${slug}: wired to no agent; its text was "Nobody reads this."`,
  )
  assert.equal(lineFor(lines, 'c1-blank'), `deleted "Blank" (c1-blank) in ${slug}: it held no text`)
})

test('a second run finds nothing to move and changes nothing', async () => {
  const slug = await space({
    nodes: [agent('d1-agent'), instruction('d1-tone', { name: 'Tone', instruction: 'Answer in English.' })],
    edges: [wire('d1-e', 'd1-tone', 'd1-agent')],
  })
  await migrateInstructionNodes()
  const after = dataOf(slug, 'd1-agent').workspaceInstructions
  assert.equal(after, '## Tone\n\nAnswer in English.\n')

  const again = await migrateInstructionNodes()
  assert.equal(
    again.some((line) => line.includes(slug)),
    false,
    `nothing of ${slug} is reported again: ${JSON.stringify(again)}`,
  )
  assert.equal(dataOf(slug, 'd1-agent').workspaceInstructions, after)
})

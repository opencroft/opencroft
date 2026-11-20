// An agent-tool node's call end to end through handleToolCall: a script node's
// returned body reaches the caller as executeAgentTool forms it (a content list
// as it is, see agent-tool-result.ts), a malformed content list fails the call
// as a tool error naming the tool, and a screenshot-sized picture arrives whole.
//
// Exercises the real database (embedded PGlite) and the real builtin/core
// script runtime — see @opencroft/db's test-env.
import '@opencroft/db/test-env'

import assert from 'node:assert/strict'
import { randomBytes } from 'node:crypto'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test, { after } from 'node:test'

import sharp from 'sharp'

import { AGENT_TOOL_NODE_TYPE } from '@/app/_authed/(agent)/_shared/agent-node-shape'
import { getSpacesRegistry } from '@/app/_authed/(space)/_server/store'
import { handleToolCall } from './tools'

const suffix = crypto.randomUUID().slice(0, 8)

// A 1×1 PNG.
const PNG = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg=='

// Each tool's handler script returns this body.
const BODIES = {
  image: {
    content: [
      { type: 'image', data: PNG, mimeType: 'image/png' },
      { type: 'text', text: 'One pixel' },
    ],
  },
  text: 'plain answer',
  object: { ok: true, items: [1, 2] },
  unknown: { content: [{ type: 'video', data: 'x' }] },
}
type Kind = keyof typeof BODIES

const toolName = (kind: Kind) => `content_list_${suffix}_${kind}`

const registry = getSpacesRegistry()
await registry.ensureLoaded()
const kinds = Object.keys(BODIES) as Kind[]
await registry.create(`agent-tool-result-${suffix}`, `agent-tool-result-${suffix}`, {
  nodes: kinds.flatMap((kind) => [
    {
      id: `tool-${kind}`,
      type: AGENT_TOOL_NODE_TYPE,
      position: { x: 0, y: 0 },
      data: { name: toolName(kind), description: `Returns ${kind}.`, inputSchema: '{}', requireApproval: false },
    },
    {
      id: `script-${kind}`,
      type: 'script',
      position: { x: 200, y: 0 },
      data: {
        language: 'node',
        script: `function handler(event) { return { status: 200, body: ${JSON.stringify(BODIES[kind])} }; }`,
      },
    },
  ]),
  edges: kinds.map((kind) => ({
    id: `edge-${kind}`,
    source: `tool-${kind}`,
    sourceHandle: 'exec-out',
    target: `script-${kind}`,
    targetHandle: 'exec-in',
  })),
})

test('a handler returning a content list answers the call with its image and text items as they are', async () => {
  const result = await handleToolCall(toolName('image'), {}, { internal: true })
  assert.deepEqual(result, BODIES.image)
})

test('a handler returning a string or an object answers as text, the object as JSON', async () => {
  assert.deepEqual(await handleToolCall(toolName('text'), {}, { internal: true }), {
    content: [{ type: 'text', text: 'plain answer' }],
  })
  assert.deepEqual(await handleToolCall(toolName('object'), {}, { internal: true }), {
    content: [{ type: 'text', text: '{"ok":true,"items":[1,2]}' }],
  })
})

test('a content list with an unknown item type fails the call, naming the tool and the type', async () => {
  await assert.rejects(
    handleToolCall(toolName('unknown'), {}, { internal: true }),
    new RegExp(`^Error: Agent tool "${toolName('unknown')}" error: .*content\\[0\\] has type "video"`),
  )
})

test('a handler printing more than a handler may fails the call naming the cap, not as malformed JSON', async () => {
  const name = `content_list_${suffix}_over_cap`
  await registry.create(`agent-tool-result-cap-${suffix}`, `agent-tool-result-cap-${suffix}`, {
    nodes: [
      {
        id: 'tool-cap',
        type: AGENT_TOOL_NODE_TYPE,
        position: { x: 0, y: 0 },
        data: { name, description: 'Returns too much.', inputSchema: '{}', requireApproval: false },
      },
      {
        id: 'script-cap',
        type: 'script',
        position: { x: 200, y: 0 },
        data: {
          language: 'node',
          script: `function handler(event) { return { status: 200, body: 'x'.repeat(6 * 1024 * 1024) }; }`,
        },
      },
    ],
    edges: [
      { id: 'edge-cap', source: 'tool-cap', sourceHandle: 'exec-out', target: 'script-cap', targetHandle: 'exec-in' },
    ],
  })
  await assert.rejects(
    handleToolCall(name, {}, { internal: true }),
    new RegExp(`^Error: Agent tool "${name}" error: The handler's output passed the 5 MB a handler may print`),
  )
})

const scratch = mkdtempSync(join(tmpdir(), 'agent-tool-result-'))
after(() => rmSync(scratch, { recursive: true, force: true }))

test('a Node.js handler answering with a picture of half a megabyte hands all of it to the caller', async () => {
  // Noise does not compress, so the PNG is about as large as its pixels.
  const png = await sharp(randomBytes(420 * 400 * 3), { raw: { width: 420, height: 400, channels: 3 } })
    .png()
    .toBuffer()
  assert.ok(png.length > 400_000, `the picture is ${png.length} bytes, larger than a pipe's worth of output`)
  const file = join(scratch, 'noise.png')
  writeFileSync(file, png)
  const name = `content_list_${suffix}_large`
  await registry.create(`agent-tool-result-large-${suffix}`, `agent-tool-result-large-${suffix}`, {
    nodes: [
      {
        id: 'tool-large',
        type: AGENT_TOOL_NODE_TYPE,
        position: { x: 0, y: 0 },
        data: { name, description: 'Returns a large picture.', inputSchema: '{}', requireApproval: false },
      },
      {
        id: 'script-large',
        type: 'script',
        position: { x: 200, y: 0 },
        data: {
          language: 'node',
          script: `const fs = require('fs');
function handler(event) {
  const data = fs.readFileSync(${JSON.stringify(file)}).toString('base64');
  return { status: 200, body: { content: [{ type: 'image', data, mimeType: 'image/png' }] } };
}`,
        },
      },
    ],
    edges: [
      {
        id: 'edge-large',
        source: 'tool-large',
        sourceHandle: 'exec-out',
        target: 'script-large',
        targetHandle: 'exec-in',
      },
    ],
  })
  const result = await handleToolCall(name, {}, { internal: true })
  assert.deepEqual(result, { content: [{ type: 'image', data: png.toString('base64'), mimeType: 'image/png' }] })
})

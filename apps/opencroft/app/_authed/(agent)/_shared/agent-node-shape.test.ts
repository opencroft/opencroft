import assert from 'node:assert/strict'
import test from 'node:test'

import {
  AGENT_NODE_TYPE,
  AGENT_TOOL_NODE_TYPE,
  agentInstructionName,
  agentInstructionText,
  agentNodeAvatar,
  agentNodeName,
  isAgentInstructionNode,
  isAgentNode,
  SEND_MESSAGE_NODE_TYPE,
} from './agent-node-shape'

test('isAgentNode/isAgentInstructionNode match only their own type', () => {
  assert.equal(isAgentNode({ type: 'builtin.core.agent' }), true)
  assert.equal(isAgentNode({ type: 'builtin.core.agent-instruction' }), false)
  assert.equal(isAgentInstructionNode({ type: 'builtin.core.agent-instruction' }), true)
  assert.equal(isAgentInstructionNode({ type: 'builtin.core.agent' }), false)
  assert.equal(isAgentNode({}), false)
})

test("the agent types are core's, qualified: neither a bare name nor another extension's is one", () => {
  assert.equal(AGENT_NODE_TYPE, 'builtin.core.agent')
  assert.equal(AGENT_TOOL_NODE_TYPE, 'builtin.core.agent-tool')
  assert.equal(SEND_MESSAGE_NODE_TYPE, 'builtin.core.send-message')
  assert.equal(isAgentNode({ type: 'agent' }), false)
  assert.equal(isAgentNode({ type: 'acme.widgets.agent' }), false)
})

test('agentNodeName trims and defaults to empty, never throws on missing data', () => {
  assert.equal(agentNodeName({ data: { name: '  Alice  ' } }), 'Alice')
  assert.equal(agentNodeName({ data: {} }), '')
  assert.equal(agentNodeName({}), '')
  assert.equal(agentNodeName({ data: { name: 42 } }), '', 'a non-string value reads as empty, not a thrown error')
})

test('agentNodeAvatar returns undefined rather than an empty string when absent', () => {
  assert.equal(agentNodeAvatar({ data: { avatar: 'https://example.invalid/a.png' } }), 'https://example.invalid/a.png')
  assert.equal(agentNodeAvatar({ data: {} }), undefined)
  assert.equal(agentNodeAvatar({}), undefined)
})

test('agentInstructionName/agentInstructionText read their own fields independently', () => {
  const instr = { type: 'builtin.core.agent-instruction', data: { name: 'Tone', instruction: 'Be terse.' } }
  assert.equal(agentInstructionName(instr), 'Tone')
  assert.equal(agentInstructionText(instr), 'Be terse.')
  assert.equal(agentInstructionName({}), '')
  assert.equal(agentInstructionText({ data: {} }), '')
})

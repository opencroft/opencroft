import assert from 'node:assert/strict'
import test from 'node:test'

import {
  agentInstructionName,
  agentInstructionText,
  agentNodeAvatar,
  agentNodeName,
  isAgentInstructionNode,
  isAgentNode,
} from './agent-node-shape'

test('isAgentNode/isAgentInstructionNode match only their own type', () => {
  assert.equal(isAgentNode({ type: 'agent' }), true)
  assert.equal(isAgentNode({ type: 'agent-instruction' }), false)
  assert.equal(isAgentInstructionNode({ type: 'agent-instruction' }), true)
  assert.equal(isAgentInstructionNode({ type: 'agent' }), false)
  assert.equal(isAgentNode({}), false)
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
  const instr = { type: 'agent-instruction', data: { name: 'Tone', instruction: 'Be terse.' } }
  assert.equal(agentInstructionName(instr), 'Tone')
  assert.equal(agentInstructionText(instr), 'Be terse.')
  assert.equal(agentInstructionName({}), '')
  assert.equal(agentInstructionText({ data: {} }), '')
})

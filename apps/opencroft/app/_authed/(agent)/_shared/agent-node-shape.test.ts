import assert from 'node:assert/strict'
import test from 'node:test'

import {
  AGENT_NODE_TYPE,
  AGENT_TOOL_NODE_TYPE,
  agentNodeAvatar,
  agentNodeName,
  isAgentNode,
  SEND_MESSAGE_NODE_TYPE,
} from './agent-node-shape'

test('isAgentNode matches only the Agent type', () => {
  assert.equal(isAgentNode({ type: 'builtin.core.agent' }), true)
  assert.equal(isAgentNode({ type: 'builtin.core.agent-tool' }), false)
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

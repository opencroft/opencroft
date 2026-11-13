import assert from 'node:assert/strict'
import test from 'node:test'

import { planContainerMove, planServerMove, type TerminalHandle } from './placement-move'

const inContainer = { nodeId: 'agent-1', containerName: 'agents-box', slug: 'release-bot' }
const workspace = '/srv/app/data/agent-workspace/helper'

function handle(over: Partial<TerminalHandle>): TerminalHandle {
  return {
    nodeId: 'app-1',
    handleId: 'instance-terminal-agents-box',
    type: 'opencroft.docker.application',
    nodeName: 'Agents box',
    ...over,
  }
}

test('the one Application whose container has the name takes the agent, in the workdir it had', () => {
  assert.deepEqual(
    planContainerMove(inContainer, [handle({}), handle({ nodeId: 'app-2', handleId: 'instance-terminal-other' })]),
    { kind: 'move', terminal: 'app-1/instance-terminal-agents-box', folder: '/agents/release-bot' },
  )
})

test('a terminal of the same id on something that is not an Application does not count', () => {
  assert.equal(planContainerMove(inContainer, [handle({ type: 'builtin.core.server' })]).kind, 'stay')
})

test('no matching Application leaves the agent, with an error naming the container', () => {
  const move = planContainerMove(inContainer, [])
  assert.equal(move.kind === 'stay' && move.error.title, 'Container placement is gone: no Application found')
  assert.match(move.kind === 'stay' ? (move.error.detail ?? '') : '', /"agents-box"/)
})

test('several matching Applications leave the agent rather than guess, naming them', () => {
  const move = planContainerMove(inContainer, [handle({}), handle({ nodeId: 'app-2', nodeName: 'Other host' })])
  assert.equal(move.kind === 'stay' && move.error.title, 'Container placement is gone: several Applications found')
  assert.match(move.kind === 'stay' ? (move.error.detail ?? '') : '', /Agents box, Other host/)
})

test("an agent on the server goes to its graph's one Localhost node, in the workspace it had", () => {
  assert.deepEqual(planServerMove({ inGraph: ['local-1'], inSpace: ['local-1', 'local-2'] }, workspace), {
    kind: 'move',
    terminal: 'local-1/terminal',
    folder: workspace,
  })
})

test("with none on its graph, the space's one Localhost node takes it", () => {
  assert.deepEqual(planServerMove({ inGraph: [], inSpace: ['local-2'] }, workspace), {
    kind: 'move',
    terminal: 'local-2/terminal',
    folder: workspace,
  })
})

test('no Localhost node, or several, leaves the agent on the server with a named error', () => {
  const none = planServerMove({ inGraph: [], inSpace: [] }, workspace)
  assert.equal(none.kind === 'stay' && none.error.title, 'Running on the server is gone: no Localhost node found')
  const several = planServerMove({ inGraph: [], inSpace: ['local-1', 'local-2'] }, workspace)
  assert.equal(
    several.kind === 'stay' && several.error.title,
    'Running on the server is gone: several Localhost nodes found',
  )
  assert.match(several.kind === 'stay' ? (several.error.next ?? '') : '', /\/srv\/app\/data\/agent-workspace\/helper/)
})

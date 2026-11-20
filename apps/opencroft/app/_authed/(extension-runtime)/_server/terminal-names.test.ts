import assert from 'node:assert/strict'
import test from 'node:test'

import { terminalDetail, terminalTitle } from './terminal-names'

const TERMINAL = 'builtin.core.terminal-context'
const plain = (id: string, label?: string) => ({ id, handleType: TERMINAL, label })
const dynamic = (id: string) => ({ id, handleType: TERMINAL, dynamic: true })

test("a node's one terminal is named after the node", () => {
  const detail = terminalDetail([plain('terminal', 'Terminal')], 'terminal')
  assert.equal(detail, '')
  assert.equal(terminalTitle({ kind: 'node', name: 'My laptop' }, detail), 'My laptop')
})

test("an Application's container named like the node is named once", () => {
  const detail = terminalDetail([dynamic('container-')], 'container-agent-container')
  assert.equal(detail, 'agent-container')
  assert.equal(terminalTitle({ kind: 'node', name: 'agent-container' }, detail), 'agent-container')
})

test("an Application's container named otherwise follows the node's name", () => {
  const detail = terminalDetail([dynamic('container-')], 'container-agent-container')
  assert.equal(terminalTitle({ kind: 'node', name: 'Agent box' }, detail), 'Agent box · agent-container')
})

test("a Docker host's containers are told apart by their names after the host's", () => {
  const declared = [dynamic('container-')]
  const names = ['container-postgres', 'container-redis'].map((id) =>
    terminalTitle({ kind: 'node', name: 'Docker' }, terminalDetail(declared, id)),
  )
  assert.deepEqual(names, ['Docker · postgres', 'Docker · redis'])
})

test("an App's worktree is what the App calls it, without the App's name in front", () => {
  const detail = terminalDetail(
    [dynamic('worktree-terminal-')],
    'worktree-terminal-repo-my--branch',
    'repo · my-branch',
  )
  assert.equal(terminalTitle({ kind: 'app', name: 'Git' }, detail), 'repo · my-branch')
})

test("an App's handle it gives no name of its own is told by its live remainder", () => {
  const detail = terminalDetail([dynamic('worktree-terminal-')], 'worktree-terminal-repo-main')
  assert.equal(terminalTitle({ kind: 'app', name: 'Git' }, detail), 'repo-main')
})

test("an App's only plain terminal is the App's name", () => {
  const detail = terminalDetail([plain('terminal')], 'terminal')
  assert.equal(terminalTitle({ kind: 'app', name: 'Notes' }, detail), 'Notes')
})

test('a static terminal is told by its label only when the owner declares several of its type', () => {
  const declared = [plain('shell', 'Shell'), plain('root', 'Root shell'), { id: 'other', handleType: 'acme.x.other' }]
  assert.equal(terminalDetail(declared, 'root'), 'Root shell')
  assert.equal(terminalTitle({ kind: 'node', name: 'Box' }, terminalDetail(declared, 'root')), 'Box · Root shell')
  assert.equal(terminalDetail([plain('root', 'Root shell'), { id: 'other', handleType: 'acme.x.other' }], 'root'), '')
})

test('a handle no declaration matches is told by its id', () => {
  assert.equal(terminalDetail([plain('terminal')], 'gone-handle'), 'gone-handle')
})

test('an owner whose declarations are not known is named by itself alone', () => {
  assert.equal(terminalDetail([], 'terminal'), '')
  assert.equal(terminalTitle({ kind: 'node', name: 'laptop' }, terminalDetail([], 'terminal')), 'laptop')
})

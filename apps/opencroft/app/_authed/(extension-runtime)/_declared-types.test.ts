import assert from 'node:assert/strict'
import test, { mock } from 'node:test'

import { declaredTypesOf, resolveCodeTypeRef } from '@/app/_authed/(extension-runtime)/_declared-types'

const ID = 'acme.widgets'
const nothingDeclared = () => false

test("a bare core type the extension does not declare is core's", () => {
  assert.equal(resolveCodeTypeRef(ID, 'terminal-context', nothingDeclared), 'builtin.core.terminal-context')
  assert.equal(resolveCodeTypeRef(ID, 'section', nothingDeclared), 'builtin.core.section')
})

test("a bare core name the extension declares itself is the extension's own", () => {
  const declared = new Set(['acme.widgets.text-stream'])
  assert.equal(
    resolveCodeTypeRef(ID, 'text-stream', (type) => declared.has(type)),
    'acme.widgets.text-stream',
  )
})

test("a bare name core does not declare is the extension's own, and a qualified one is kept", () => {
  assert.equal(resolveCodeTypeRef(ID, 'gauge', nothingDeclared), 'acme.widgets.gauge')
  assert.equal(resolveCodeTypeRef(ID, 'other.ext.terminal-context', nothingDeclared), 'other.ext.terminal-context')
})

test("reading a bare name as core's type warns once per extension and name, and nothing else warns", () => {
  const log = mock.method(console, 'warn', () => {})
  try {
    resolveCodeTypeRef('acme.once', 'text-stream', nothingDeclared)
    resolveCodeTypeRef('acme.once', 'text-stream', nothingDeclared)
    resolveCodeTypeRef('acme.once', 'gauge', nothingDeclared)
    resolveCodeTypeRef('acme.once', 'builtin.core.section', nothingDeclared)
    resolveCodeTypeRef('acme.once', 'section', (type) => type === 'acme.once.section')
    assert.deepEqual(
      log.mock.calls.map((call) => call.arguments[0]),
      [
        '[ext] acme.once: the bare "text-stream" is read as core\'s type, which is deprecated — name it "builtin.core.text-stream"',
      ],
    )
  } finally {
    log.mock.restore()
  }
})

test('the declared types of a read manifest are its nodes, handle types and Apps', () => {
  assert.deepEqual(
    [
      ...declaredTypesOf({
        nodes: [{ type: 'acme.widgets.gauge' }],
        handleTypes: [{ id: 'acme.widgets.signal' }],
        provides: { apps: [{ type: 'acme.widgets.board' }] },
      }),
    ],
    ['acme.widgets.gauge', 'acme.widgets.signal', 'acme.widgets.board'],
  )
})

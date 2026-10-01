// Resolution of getNodeActionAccess — specifically the fail-OPEN defaults, the
// paths where a resolution bug would silently open the gate rather than close
// it. The declared→admin case (a node whose owning extension declares an action
// admin) is proven end to end against the design-kit, which is the only
// extension that declares nodeActionAccess and is not loaded in this core test
// env; here we pin the three ways resolution must fall back to 'signed-in' so a
// future change cannot turn a fallback into an accidental admin gate or, worse,
// leave a real gate un-resolved.
import '@opencroft/db/test-env'

import assert from 'node:assert/strict'
import test from 'node:test'

import { getSpacesRegistry } from '@/app/_authed/(space)/_server/store'
import { getNodeActionAccess } from './node-actions-impl'

test('an unknown node id resolves to signed-in — no node, nothing to gate', async () => {
  assert.equal(await getNodeActionAccess(`no-such-node-${crypto.randomUUID()}`, 'writeFiles'), 'signed-in')
})

test('a node whose type no installed extension owns resolves to signed-in', async () => {
  const slug = `node-access-unowned-${crypto.randomUUID()}`
  await getSpacesRegistry().create(slug, slug, {
    nodes: [{ id: 'n1', type: 'no-such-node-type', position: { x: 0, y: 0 }, data: {} }],
    edges: [],
  })
  assert.equal(await getNodeActionAccess('n1', 'anything'), 'signed-in')
})

test('a node of a real extension that declares no nodeActionAccess resolves to signed-in', async () => {
  const slug = `node-access-undeclared-${crypto.randomUUID()}`
  // `text-generation` is a builtin.core node type, and builtin.core declares no
  // nodeActionAccess, so any of its actions defaults to signed-in.
  await getSpacesRegistry().create(slug, slug, {
    nodes: [{ id: 'tg1', type: 'builtin.core.text-generation', position: { x: 0, y: 0 }, data: {} }],
    edges: [],
  })
  assert.equal(await getNodeActionAccess('tg1', 'run'), 'signed-in')
})

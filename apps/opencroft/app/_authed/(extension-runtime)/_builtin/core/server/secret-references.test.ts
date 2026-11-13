import assert from 'node:assert/strict'
import test from 'node:test'

import { DELETE_OVERRIDE_PARAM } from './checked-delete'
import {
  deleteSecretChecked,
  renameSecretChecked,
  type SecretReference,
  secretDeleteRefusal,
  secretRenameRefusal,
} from './secret-references'

// ── secretDeleteRefusal ──────────────────────────────────────────────────
// When a delete is refused is `deleteChecked`'s rule (checked-delete.test.ts);
// these pin what the Secrets Store says when it is.

test('the refusal names every node', () => {
  const message = secretDeleteRefusal('API_TOKEN', [
    { nodeId: 'app-1', nodeType: 'application', nodeName: 'reporting-worker' },
    { nodeId: 'app-2', nodeType: 'application' },
  ])
  assert.match(message, /API_TOKEN/)
  assert.match(message, /reporting-worker \(app-1\)/)
  // No name of its own, so the type identifies it — never a bare id the reader
  // has to go and look up.
  assert.match(message, /application \(app-2\)/)
})

test('the refusal names the parameter that overrides it', () => {
  assert.match(
    secretDeleteRefusal('API_TOKEN', [{ nodeId: 'app-1', nodeType: 'application' }]),
    new RegExp(DELETE_OVERRIDE_PARAM),
  )
})

test('the refusal counts the nodes and Apps it names', () => {
  assert.match(secretDeleteRefusal('API_TOKEN', [{ nodeId: 'app-1' }]), /named by 1 node or App —/)
  assert.match(
    secretDeleteRefusal('API_TOKEN', [{ nodeId: 'app-1' }, { nodeId: 'app-2' }]),
    /named by 2 nodes or Apps —/,
  )
})

test('the refusal names an App by its name and address', () => {
  const references = [{ nodeId: 'home.docs', nodeType: 'app:documentation', nodeName: 'Docs' }]
  assert.match(secretDeleteRefusal('API_TOKEN', references), /Docs \(home\.docs\)/)
})

// ── deleteSecretChecked ──────────────────────────────────────────────────
// The one delete by name, behind both the agent action and the inspector.

/** A store holding `keys`, named by `references`, that records whether it removed anything. */
function fakeStore(keys: string[], references: SecretReference[]) {
  const store = {
    removed: 0,
    listKeys: async () => keys,
    listReferences: async () => references,
    remove: async () => {
      store.removed += 1
    },
  }
  return store
}

test('a secret a node still names is refused in the Secrets Store wording, and nothing is removed', async () => {
  const references = [{ nodeId: 'app-1', nodeName: 'reporting-worker' }]
  const store = fakeStore(['API_TOKEN'], references)
  const outcome = await deleteSecretChecked('API_TOKEN', false, store)
  assert.ok('refused' in outcome)
  assert.deepEqual(outcome.refused, { references, message: secretDeleteRefusal('API_TOKEN', references) })
  assert.equal(store.removed, 0)
})

test('the override deletes a secret a node still names', async () => {
  const store = fakeStore(['API_TOKEN'], [{ nodeId: 'app-1' }])
  assert.deepEqual(await deleteSecretChecked('API_TOKEN', true, store), { deleted: 'API_TOKEN' })
  assert.equal(store.removed, 1)
})

test('the nodes a confirm listed delete a secret they name', async () => {
  const store = fakeStore(['API_TOKEN'], [{ nodeId: 'app-1' }])
  assert.deepEqual(await deleteSecretChecked('API_TOKEN', ['app-1'], store), { deleted: 'API_TOKEN' })
  assert.equal(store.removed, 1)
})

test('a node the confirm did not list refuses the delete, and the refusal lists every node naming it', async () => {
  const references = [{ nodeId: 'app-1' }, { nodeId: 'app-2', nodeName: 'late-worker' }]
  const store = fakeStore(['API_TOKEN'], references)
  const outcome = await deleteSecretChecked('API_TOKEN', ['app-1'], store)
  assert.ok('refused' in outcome)
  assert.deepEqual(outcome.refused.references, references)
  assert.equal(store.removed, 0)
})

test('a name the store does not hold is refused as an absent secret, and nothing is removed', async () => {
  const store = fakeStore(['API_TOKEN'], [])
  await assert.rejects(deleteSecretChecked('API_TOKN', false, store), /^Error: Secret "API_TOKN" is not in this store$/)
  assert.equal(store.removed, 0)
})

// ── renameSecretChecked ──────────────────────────────────────────────────
// The inspector's rename: the delete's in-use check on the old name, and no
// override at all for a new name the store already holds.

/** A store holding `keys`, named by `references`, that records each rename it was asked for. */
function fakeRenameStore(keys: string[], references: SecretReference[]) {
  const store = {
    renamed: [] as string[],
    listKeys: async () => keys,
    listReferences: async () => references,
    rename: async (to: string) => {
      store.renamed.push(to)
    },
  }
  return store
}

test('a rename nothing names goes through under the trimmed new name', async () => {
  const store = fakeRenameStore(['API_TOKEN'], [])
  assert.deepEqual(await renameSecretChecked('API_TOKEN', ' API_KEY ', false, store), { renamed: 'API_KEY' })
  assert.deepEqual(store.renamed, ['API_KEY'])
})

test('a rename onto a name the store holds is refused, whatever the override, and nothing is renamed', async () => {
  const store = fakeRenameStore(['API_TOKEN', 'API_KEY'], [])
  for (const override of [false, true, ['app-1']]) {
    await assert.rejects(
      renameSecretChecked('API_TOKEN', 'API_KEY', override, store),
      /^Error: A secret named "API_KEY" is already in this store; delete it or choose another name$/,
    )
  }
  assert.deepEqual(store.renamed, [])
})

test('a rename of a secret a node still names is refused with every node naming it, and nothing is renamed', async () => {
  const references = [{ nodeId: 'app-1', nodeName: 'reporting-worker' }]
  const store = fakeRenameStore(['API_TOKEN'], references)
  const outcome = await renameSecretChecked('API_TOKEN', 'API_KEY', false, store)
  assert.ok('refused' in outcome)
  assert.deepEqual(outcome.refused, {
    references,
    message: secretRenameRefusal('API_TOKEN', 'API_KEY', references),
  })
  assert.match(outcome.refused.message, /rename "API_TOKEN" to "API_KEY".*reporting-worker \(app-1\)/)
  assert.deepEqual(store.renamed, [])
})

test('the nodes a confirm listed rename a secret they name; one it did not list refuses it', async () => {
  const listed = fakeRenameStore(['API_TOKEN'], [{ nodeId: 'app-1' }])
  assert.deepEqual(await renameSecretChecked('API_TOKEN', 'API_KEY', ['app-1'], listed), { renamed: 'API_KEY' })
  const late = fakeRenameStore(['API_TOKEN'], [{ nodeId: 'app-1' }, { nodeId: 'app-2' }])
  assert.ok('refused' in (await renameSecretChecked('API_TOKEN', 'API_KEY', ['app-1'], late)))
  assert.deepEqual(late.renamed, [])
})

test('a rename from a name the store does not hold, or to a blank one, is refused, and nothing is renamed', async () => {
  const store = fakeRenameStore(['API_TOKEN'], [])
  await assert.rejects(
    renameSecretChecked('API_TOKN', 'API_KEY', false, store),
    /^Error: Secret "API_TOKN" is not in this store$/,
  )
  await assert.rejects(renameSecretChecked('API_TOKEN', '  ', false, store), /Secret name is required/)
  assert.deepEqual(store.renamed, [])
})

test('a rename to the name the secret already has changes nothing', async () => {
  const store = fakeRenameStore(['API_TOKEN'], [{ nodeId: 'app-1' }])
  assert.deepEqual(await renameSecretChecked('API_TOKEN', 'API_TOKEN', false, store), { renamed: 'API_TOKEN' })
  assert.deepEqual(store.renamed, [])
})

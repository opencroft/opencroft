import assert from 'node:assert/strict'
import test from 'node:test'

import type { DeleteOutcome, NodeReference, RenameOutcome } from './delete-refusal-shared'
import {
  applyAnyway,
  duplicateRows,
  type ListedCalls,
  mergeWritten,
  removeSecretRow,
  rowTarget,
  type SaveCalls,
  type SecretEdit,
  type SecretRow,
  saveSecrets,
  unnamedRows,
} from './secrets-store-save'

function row(rowId: string, key: string, fields: Partial<SecretRow> = {}): SecretRow {
  return { rowId, key, value: 'v', dirty: false, ...fields }
}

// ── removeSecretRow ──────────────────────────────────────────────────────

test('removing a saved row lists its stored name once, and only that row goes', () => {
  const edit: SecretEdit = { rows: [row('r1', 'A', { savedKey: 'A' }), row('r2', 'B', { savedKey: 'B' })], removed: [] }
  assert.deepEqual(removeSecretRow(edit, 0), { rows: [edit.rows[1]], removed: ['A'] })
})

test('removing a renamed saved row lists the name the store holds, not the typed one', () => {
  const edit: SecretEdit = { rows: [row('r1', 'A_NEW', { savedKey: 'A', dirty: true })], removed: [] }
  assert.deepEqual(removeSecretRow(edit, 0).removed, ['A'])
})

test('removing an unsaved row lists nothing to delete', () => {
  const edit: SecretEdit = { rows: [row('r1', 'NEW', { dirty: true })], removed: ['OLD'] }
  assert.deepEqual(removeSecretRow(edit, 0), { rows: [], removed: ['OLD'] })
})

test('removeSecretRow gives the same edit when called twice on one state, as a state updater may be', () => {
  const edit: SecretEdit = { rows: [row('r1', 'A', { savedKey: 'A' })], removed: [] }
  const before = structuredClone(edit)
  const first = removeSecretRow(edit, 0)
  const second = removeSecretRow(edit, 0)
  assert.deepEqual(second, first)
  assert.deepEqual(edit, before)
})

/** Records every call in order; `refuse` names keys whose delete is refused, `fail` keys whose call throws. */
function fakeCalls({ refuse = [], fail = [] }: { refuse?: string[]; fail?: string[] } = {}) {
  const log: string[] = []
  const calls: SaveCalls = {
    deleteSecret: async (key): Promise<DeleteOutcome> => {
      log.push(`delete ${key}`)
      if (fail.includes(key)) {
        throw new Error('store unavailable')
      }
      if (refuse.includes(key)) {
        return { refused: { references: [{ nodeId: 'app-1', nodeName: 'reporting-worker' }], message: 'in use' } }
      }
      return { deleted: key }
    },
    renameSecret: async (from, to): Promise<RenameOutcome> => {
      log.push(`rename ${from} to ${to}`)
      if (fail.includes(from)) {
        throw new Error('name taken')
      }
      if (refuse.includes(from)) {
        return { refused: { references: [{ nodeId: 'app-1', nodeName: 'reporting-worker' }], message: 'in use' } }
      }
      return { renamed: to }
    },
    setSecret: async (key, value) => {
      log.push(`set ${key}=${value}`)
      if (fail.includes(key)) {
        throw new Error('store unavailable')
      }
    },
  }
  return { calls, log }
}

/** A row as the inspector loads it from the store. */
function saved(rowId: string, key: string, value: string): SecretRow {
  return row(rowId, key, { savedKey: key, value, savedValue: value })
}

test('a blank added row stops the save before anything is sent', async () => {
  const { calls, log } = fakeCalls()
  const rows = [row('a', 'API_TOKEN', { dirty: true }), row('b', '', { value: '', dirty: true })]
  assert.deepEqual(await saveSecrets(rows, ['OLD_TOKEN'], calls), { status: 'unnamed', rowIds: ['b'] })
  assert.deepEqual(log, [])
})

test('a name of spaces counts as no name', () => {
  assert.deepEqual(unnamedRows([row('a', '   ', { dirty: true })]), ['a'])
})

test('an unchanged row is not checked for a name', () => {
  // Only rows being written can be refused; a saved row is not re-sent.
  assert.deepEqual(unnamedRows([row('a', '', { dirty: false })]), [])
})

test("a row renamed onto a new row's name stops the save before anything is sent", async () => {
  const { calls, log } = fakeCalls()
  const rows = [
    { ...saved('a', 'OLD_TOKEN', 'kept'), key: 'NEW_TOKEN', dirty: true },
    row('b', 'NEW_TOKEN', { value: 'x', dirty: true }),
  ]
  assert.deepEqual(await saveSecrets(rows, ['GONE_TOKEN'], calls), { status: 'duplicate', rowIds: ['a', 'b'] })
  assert.deepEqual(log, [])
})

test('a new row named as an unchanged saved row stops the save before anything is sent', async () => {
  const { calls, log } = fakeCalls()
  const rows = [saved('a', 'API_TOKEN', 'kept'), row('b', ' API_TOKEN ', { value: 'x', dirty: true })]
  assert.deepEqual(await saveSecrets(rows, [], calls), { status: 'duplicate', rowIds: ['a', 'b'] })
  assert.deepEqual(log, [])
})

test('only the rows that share a name are marked, and blank names are left to the name check', () => {
  const rows = [
    row('a', 'A_TOKEN'),
    row('b', 'B_TOKEN'),
    row('c', 'A_TOKEN', { dirty: true }),
    row('d', '', { dirty: true }),
    row('e', ' ', { dirty: true }),
  ]
  assert.deepEqual(duplicateRows(rows), ['a', 'c'])
})

test('a new row may take the name of a removed secret', async () => {
  const { calls, log } = fakeCalls()
  const rows = [row('a', 'API_TOKEN', { value: 'x', dirty: true })]
  assert.deepEqual(await saveSecrets(rows, ['API_TOKEN'], calls), { status: 'done', refused: [], failed: [] })
  assert.deepEqual(log, ['delete API_TOKEN', 'set API_TOKEN=x'])
})

test('a refused delete is reported with the nodes that name it, and the other edits still save', async () => {
  const { calls, log } = fakeCalls({ refuse: ['USED_TOKEN'] })
  const rows = [row('a', 'NEW_TOKEN', { value: 'n', dirty: true })]
  const result = await saveSecrets(rows, ['USED_TOKEN', 'FREE_TOKEN'], calls)
  assert.deepEqual(result, {
    status: 'done',
    refused: [{ key: 'USED_TOKEN', references: [{ nodeId: 'app-1', nodeName: 'reporting-worker' }] }],
    failed: [],
  })
  assert.deepEqual(log, ['delete USED_TOKEN', 'delete FREE_TOKEN', 'set NEW_TOKEN=n'])
})

test('a failed call is reported by name and does not stop the rest', async () => {
  const { calls, log } = fakeCalls({ fail: ['BROKEN_TOKEN'] })
  const rows = [row('a', 'BROKEN_TOKEN', { dirty: true }), row('b', 'GOOD_TOKEN', { dirty: true })]
  const result = await saveSecrets(rows, [], calls)
  assert.deepEqual(result, { status: 'done', refused: [], failed: ['BROKEN_TOKEN: store unavailable'] })
  assert.deepEqual(log, ['set BROKEN_TOKEN=v', 'set GOOD_TOKEN=v'])
})

test('only changed rows are written, under their trimmed name', async () => {
  const { calls, log } = fakeCalls()
  const rows = [row('a', 'KEPT_TOKEN'), row('b', ' EDITED_TOKEN ', { value: 'e', dirty: true })]
  assert.deepEqual(await saveSecrets(rows, [], calls), { status: 'done', refused: [], failed: [] })
  assert.deepEqual(log, ['set EDITED_TOKEN=e'])
})

test('a renamed row is renamed in the store and its unchanged value is not written again', async () => {
  const { calls, log } = fakeCalls()
  const rows = [{ ...saved('a', 'OLD_TOKEN', 'v1'), key: ' NEW_TOKEN ', dirty: true }]
  assert.deepEqual(await saveSecrets(rows, [], calls), { status: 'done', refused: [], failed: [] })
  assert.deepEqual(log, ['rename OLD_TOKEN to NEW_TOKEN'])
})

test('a renamed row with an edited value is renamed, then its value written under the new name', async () => {
  const { calls, log } = fakeCalls()
  const rows = [{ ...saved('a', 'OLD_TOKEN', 'v1'), key: 'NEW_TOKEN', value: 'v2', dirty: true }]
  await saveSecrets(rows, [], calls)
  assert.deepEqual(log, ['rename OLD_TOKEN to NEW_TOKEN', 'set NEW_TOKEN=v2'])
})

test('a saved row whose value was edited back to the stored one writes nothing', async () => {
  const { calls, log } = fakeCalls()
  await saveSecrets([{ ...saved('a', 'TOKEN', 'v1'), dirty: true }], [], calls)
  assert.deepEqual(log, [])
})

test('renames go before value writes, so a new row can take the name a renamed row gives up', async () => {
  const { calls, log } = fakeCalls()
  const rows = [
    row('n', 'OLD_TOKEN', { value: 'fresh', dirty: true }),
    { ...saved('a', 'OLD_TOKEN', 'v1'), key: 'NEW_TOKEN', dirty: true },
  ]
  await saveSecrets(rows, [], calls)
  assert.deepEqual(log, ['rename OLD_TOKEN to NEW_TOKEN', 'set OLD_TOKEN=fresh'])
})

test('a refused rename is reported with the new name and the edited value, writes nothing, and the rest still save', async () => {
  const { calls, log } = fakeCalls({ refuse: ['USED_TOKEN'] })
  const rows = [
    { ...saved('a', 'USED_TOKEN', 'v1'), key: 'RENAMED_TOKEN', value: 'v2', dirty: true },
    row('b', 'NEW_TOKEN', { value: 'n', dirty: true }),
  ]
  assert.deepEqual(await saveSecrets(rows, [], calls), {
    status: 'done',
    refused: [
      {
        key: 'USED_TOKEN',
        references: [{ nodeId: 'app-1', nodeName: 'reporting-worker' }],
        rename: { to: 'RENAMED_TOKEN', value: 'v2' },
      },
    ],
    failed: [],
  })
  assert.deepEqual(log, ['rename USED_TOKEN to RENAMED_TOKEN', 'set NEW_TOKEN=n'])
})

test('a failed rename is reported under the stored name and writes no value under either name', async () => {
  const { calls, log } = fakeCalls({ fail: ['OLD_TOKEN'] })
  const rows = [{ ...saved('a', 'OLD_TOKEN', 'v1'), key: 'TAKEN_TOKEN', value: 'v2', dirty: true }]
  assert.deepEqual(await saveSecrets(rows, [], calls), {
    status: 'done',
    refused: [],
    failed: ['OLD_TOKEN: name taken'],
  })
  assert.deepEqual(log, ['rename OLD_TOKEN to TAKEN_TOKEN'])
})

// ── applyAnyway ──────────────────────────────────────────────────────────

const worker = { nodeId: 'node-1', nodeName: 'reporting-worker' }
const lateWorker = { nodeId: 'node-2', nodeName: 'late-worker' }

/**
 * A store where `naming` is every node naming each key at the time of the call,
 * deleting or renaming past the shown ids as the server does. Records each call
 * with the ids it sent.
 */
function fakeListed(naming: Record<string, NodeReference[]>, fail: string[] = []) {
  const log: string[] = []
  const refusal = (key: string, shown: string[]) => {
    if (fail.includes(key)) {
      throw new Error('store unavailable')
    }
    const references = naming[key] ?? []
    return references.some((ref) => !shown.includes(ref.nodeId))
      ? { refused: { references, message: 'in use' } }
      : undefined
  }
  const calls: ListedCalls = {
    deleteListed: async (key, shown) => {
      log.push(`delete ${key} past [${shown.join(', ')}]`)
      return refusal(key, shown) ?? { deleted: key }
    },
    renameListed: async (from, to, shown) => {
      log.push(`rename ${from} to ${to} past [${shown.join(', ')}]`)
      return refusal(from, shown) ?? { renamed: to }
    },
    setSecret: async (key, value) => {
      log.push(`set ${key}=${value}`)
    },
  }
  return { calls, log }
}

test('each secret is deleted past exactly the nodes the confirm listed for it', async () => {
  const { calls, log } = fakeListed({ USED_TOKEN: [worker], OTHER_TOKEN: [lateWorker] })
  const items = [
    { key: 'USED_TOKEN', references: [worker] },
    { key: 'OTHER_TOKEN', references: [lateWorker] },
  ]
  assert.deepEqual(await applyAnyway(items, calls), {
    deleted: ['USED_TOKEN', 'OTHER_TOKEN'],
    renamed: [],
    refused: [],
    failed: [],
  })
  assert.deepEqual(log, ['delete USED_TOKEN past [node-1]', 'delete OTHER_TOKEN past [node-2]'])
})

test('a refused rename is renamed past the nodes the confirm listed, then its edited value is written under the new name', async () => {
  const { calls, log } = fakeListed({ USED_TOKEN: [worker], PLAIN_TOKEN: [worker] })
  const items = [
    { key: 'USED_TOKEN', references: [worker], rename: { to: 'NEW_TOKEN', value: 'v2' } },
    { key: 'PLAIN_TOKEN', references: [worker], rename: { to: 'PLAIN_KEY' } },
  ]
  assert.deepEqual(await applyAnyway(items, calls), {
    deleted: [],
    renamed: [
      { from: 'USED_TOKEN', to: 'NEW_TOKEN' },
      { from: 'PLAIN_TOKEN', to: 'PLAIN_KEY' },
    ],
    refused: [],
    failed: [],
  })
  assert.deepEqual(log, [
    'rename USED_TOKEN to NEW_TOKEN past [node-1]',
    'set NEW_TOKEN=v2',
    'rename PLAIN_TOKEN to PLAIN_KEY past [node-1]',
  ])
})

test('a node that started naming a secret after the confirm opened refuses it, listed with every node naming it now', async () => {
  const { calls, log } = fakeListed({ USED_TOKEN: [worker, lateWorker], FREE_TOKEN: [worker] })
  const items = [
    { key: 'USED_TOKEN', references: [worker], rename: { to: 'NEW_TOKEN', value: 'v2' } },
    { key: 'FREE_TOKEN', references: [worker] },
  ]
  assert.deepEqual(await applyAnyway(items, calls), {
    deleted: ['FREE_TOKEN'],
    renamed: [],
    refused: [{ key: 'USED_TOKEN', references: [worker, lateWorker], rename: { to: 'NEW_TOKEN', value: 'v2' } }],
    failed: [],
  })
  assert.ok(!log.includes('set NEW_TOKEN=v2'), 'nothing is written for a rename that did not go through')
})

test('a failed delete is reported by name and does not stop the rest', async () => {
  const { calls } = fakeListed({}, ['BROKEN_TOKEN'])
  const items = [
    { key: 'BROKEN_TOKEN', references: [worker] },
    { key: 'GOOD_TOKEN', references: [worker] },
  ]
  assert.deepEqual(await applyAnyway(items, calls), {
    deleted: ['GOOD_TOKEN'],
    renamed: [],
    refused: [],
    failed: ['BROKEN_TOKEN: store unavailable'],
  })
})

// ── rowTarget / mergeWritten ─────────────────────────────────────────────

test('rowTarget is the stored name, a new row’s trimmed name, and nothing for a blank or renamed row', () => {
  assert.equal(rowTarget(row('r1', 'A', { savedKey: 'A' })), 'A')
  assert.equal(rowTarget(row('r1', ' NEW ', { dirty: true })), 'NEW')
  assert.equal(rowTarget(row('r1', '  ', { dirty: true })), undefined)
  assert.equal(rowTarget(row('r1', 'A_NEW', { savedKey: 'A', dirty: true })), undefined)
})

test('mergeWritten replaces the row the menu acted on and keeps its row id', () => {
  const edit: SecretEdit = { rows: [row('r1', 'A', { savedKey: 'A' })], removed: [] }
  const fresh = row('fresh', 'A', { savedKey: 'A', value: 'new', rotatable: true })
  assert.deepEqual(mergeWritten(edit, 'A', fresh).rows, [{ ...fresh, rowId: 'r1' }])
})

test('mergeWritten keeps every other row’s unsaved edit and the removed names', () => {
  const edited = row('r2', 'B', { savedKey: 'B', value: 'typed, not saved', dirty: true })
  const added = row('r3', 'NEW', { dirty: true })
  const edit: SecretEdit = { rows: [row('r1', 'A', { savedKey: 'A' }), edited, added], removed: ['GONE'] }
  const merged = mergeWritten(edit, 'NEW', row('fresh', 'NEW', { savedKey: 'NEW', value: 'made' }))
  assert.deepEqual(merged.rows[0], edit.rows[0])
  assert.deepEqual(merged.rows[1], edited)
  assert.deepEqual(merged.rows[2], row('r3', 'NEW', { savedKey: 'NEW', value: 'made' }))
  assert.deepEqual(merged.removed, ['GONE'])
})

test('mergeWritten adds the row when none names the key', () => {
  const edit: SecretEdit = { rows: [row('r1', 'A', { savedKey: 'A' })], removed: [] }
  const fresh = row('fresh', 'B', { savedKey: 'B' })
  assert.deepEqual(mergeWritten(edit, 'B', fresh).rows, [edit.rows[0], fresh])
})

import assert from 'node:assert/strict'
import test from 'node:test'

import {
  ADMINISTRATION_SECTION_IDS,
  administrationSearch,
  isAdminOnlyPath,
} from '@/app/_authed/(settings)/_lib/administration-sections'

test("each instance section's settings address leads to the same section and tab on the administration page", () => {
  assert.ok(ADMINISTRATION_SECTION_IDS.length >= 5, 'the sections are listed')
  for (const section of ADMINISTRATION_SECTION_IDS) {
    assert.deepEqual(administrationSearch({ section }), { section }, section)
  }
  assert.deepEqual(administrationSearch({ section: 'agents', tab: 'audit' }), { section: 'agents', tab: 'audit' })
})

test('the audit address leads to the Agents section on its MCP Audit tab', () => {
  assert.deepEqual(administrationSearch({ section: 'audit' }), { section: 'agents', tab: 'audit' })
})

test("the person's own sections, extension pages and the bare address stay on Settings", () => {
  assert.equal(administrationSearch({}), null)
  assert.equal(administrationSearch({ section: 'account' }), null)
  assert.equal(administrationSearch({ section: 'ext:local.example:general' }), null)
})

test('the administration page and the paths under it are for an administrator only', () => {
  assert.equal(isAdminOnlyPath('/administration'), true)
  assert.equal(isAdminOnlyPath('/administration/anything'), true)
  assert.equal(isAdminOnlyPath('/settings'), false)
  assert.equal(isAdminOnlyPath('/administrations'), false, 'a path that only starts with the same letters')
})

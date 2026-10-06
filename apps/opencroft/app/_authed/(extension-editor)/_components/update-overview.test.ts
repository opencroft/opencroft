import assert from 'node:assert/strict'
import test from 'node:test'

import type { ExtensionIndexEntry } from '@/app/_authed/(extension-editor)/_actions/extensions-index'
import type { UpdateCheck } from '@/app/_authed/(extension-editor)/_actions/installed-extensions-actions'
import type { LocalRemoteState } from '@/app/_authed/(extension-editor)/_actions/local-extensions-actions'
import { type UpdateFindings, updateOverview } from './update-overview'

const A = 'a'.repeat(40)
const B = 'b'.repeat(40)

function installed(folder: string, extra: Partial<ExtensionIndexEntry> = {}): ExtensionIndexEntry {
  return { folder, id: folder, name: folder, version: '1.0.0', kind: 'installed', active: true, ...extra }
}

function local(folder: string): ExtensionIndexEntry {
  return { folder, id: folder, name: folder, version: '1.0.0', kind: 'local', active: true }
}

function tagCheck(current: string, latest: string): UpdateCheck {
  return {
    current,
    currentCommit: A,
    latest,
    latestCommit: null,
    followsBranch: false,
    hasUpdate: current !== latest,
    availableTags: [latest],
  }
}

function remote(state: Partial<LocalRemoteState>): LocalRemoteState {
  return {
    branch: 'main',
    localCommit: A,
    remoteCommit: B,
    behind: false,
    blocked: null,
    error: null,
    errorDetail: null,
    ...state,
  }
}

const NONE: UpdateFindings = { installed: {}, installedErrors: {}, local: {} }

test('an installed extension behind its newest tag is offered it, and one at it is not listed', () => {
  const findings: UpdateFindings = {
    ...NONE,
    installed: { 'acme.old': tagCheck('v1.0.0', 'v1.1.0'), 'acme.current': tagCheck('v2.0.0', 'v2.0.0') },
  }

  const overview = updateOverview([installed('acme.old'), installed('acme.current')], findings, {})

  assert.deepEqual(overview, {
    updates: [{ id: 'acme.old', name: 'acme.old', from: 'v1.0.0', to: 'v1.1.0', state: 'available' }],
    blocked: [],
  })
})

test('an install following a branch is written as the branch and its commits', () => {
  const findings: UpdateFindings = {
    ...NONE,
    installed: {
      'acme.edge': {
        current: 'main',
        currentCommit: A,
        latest: 'main',
        latestCommit: B,
        followsBranch: true,
        hasUpdate: true,
        availableTags: [],
      },
    },
  }

  const { updates } = updateOverview([installed('acme.edge')], findings, {})

  assert.deepEqual(updates, [
    { id: 'acme.edge', name: 'acme.edge', from: 'main · aaaaaaa', to: 'main · bbbbbbb', state: 'available' },
  ])
})

test('a local checkout is offered origin when behind and clean, and listed with the reason when blocked', () => {
  const findings: UpdateFindings = {
    ...NONE,
    local: {
      'local.clean': remote({ behind: true }),
      'local.dirty': remote({ behind: true, blocked: 'The working tree carries 1 uncommitted file.' }),
      'local.detached': remote({ branch: 'HEAD', remoteCommit: null, blocked: 'The checkout is not on a branch.' }),
      'local.ahead': remote({}),
      'local.dirty-current': remote({ blocked: 'The working tree carries 1 uncommitted file.' }),
    },
  }
  const entries = ['local.clean', 'local.dirty', 'local.detached', 'local.ahead', 'local.dirty-current'].map(local)

  assert.deepEqual(updateOverview(entries, findings, {}), {
    updates: [
      { id: 'local.clean', name: 'local.clean', from: 'main · aaaaaaa', to: 'main · bbbbbbb', state: 'available' },
    ],
    blocked: [
      { id: 'local.dirty', name: 'local.dirty', reason: 'The working tree carries 1 uncommitted file.' },
      { id: 'local.detached', name: 'local.detached', reason: 'The checkout is not on a branch.' },
    ],
  })
})

test('a failed check is a reason to list, with what git said behind it; a folder that is no git checkout is not', () => {
  const findings: UpdateFindings = {
    installed: {},
    installedErrors: {
      'acme.offline': { error: 'Could not reach git.example.com.', detail: 'fatal: Could not resolve host' },
      'acme.unrecorded': { error: 'acme.unrecorded was not installed from a repository', detail: null },
    },
    local: {
      'local.unreachable': remote({
        remoteCommit: null,
        error: 'Could not sign in to git.example.com.',
        errorDetail: 'fatal: Authentication failed',
      }),
      'local.handmade': remote({ branch: null, localCommit: null, remoteCommit: null, error: 'Not a git checkout.' }),
    },
  }

  const overview = updateOverview(
    [installed('acme.offline'), installed('acme.unrecorded'), local('local.unreachable'), local('local.handmade')],
    findings,
    {},
  )

  assert.deepEqual(overview, {
    updates: [],
    blocked: [
      {
        id: 'acme.offline',
        name: 'acme.offline',
        reason: 'The check failed: Could not reach git.example.com.',
        detail: 'fatal: Could not resolve host',
      },
      {
        id: 'acme.unrecorded',
        name: 'acme.unrecorded',
        reason: 'The check failed: acme.unrecorded was not installed from a repository',
      },
      {
        id: 'local.unreachable',
        name: 'local.unreachable',
        reason: 'Could not sign in to git.example.com.',
        detail: 'fatal: Authentication failed',
      },
    ],
  })
})

test('an outcome keeps its row between the versions it was taken between, whatever a later check says', () => {
  // The re-check after the update finds nothing newer.
  const findings: UpdateFindings = { ...NONE, installed: { 'acme.old': tagCheck('v1.1.0', 'v1.1.0') } }
  const outcomes = {
    'acme.old': { state: 'updated' as const, from: 'v1.0.0', to: 'v1.1.0', message: 'Updated to v1.1.0' },
  }

  const { updates } = updateOverview([installed('acme.old')], findings, outcomes)

  assert.deepEqual(updates, [
    { id: 'acme.old', name: 'acme.old', from: 'v1.0.0', to: 'v1.1.0', state: 'updated', message: 'Updated to v1.1.0' },
  ])
})

test('a recorded install whose folder is gone is not listed, whatever its check', () => {
  const findings: UpdateFindings = { ...NONE, installed: { 'acme.gone': tagCheck('v1.0.0', 'v1.1.0') } }

  assert.deepEqual(updateOverview([installed('acme.gone', { missing: true })], findings, {}), {
    updates: [],
    blocked: [],
  })
})

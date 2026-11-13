import assert from 'node:assert/strict'
import { describe, it } from 'node:test'

import { appsOfType } from '@/app/_shell/apps-of-type'
import type { SpaceApp } from '@/app/_shell/space-navigation'

const app = (id: string, label: string, type: string): SpaceApp => ({
  id,
  label,
  type,
  href: `/space/alpha/app/${id}`,
})

describe('appsOfType', () => {
  const docs10 = app('d10', 'Docs 10', 'Documentation')
  const docs2 = app('d2', 'docs 2', 'Documentation')
  const archive = app('da', 'Archive', 'Documentation')
  const tasks = app('t', 'Tasks', 'Task Manager')
  const graph = app('g', 'Graph', 'Graph')
  const space = [docs10, tasks, docs2, graph, archive]

  it('lists the apps of the given app’s type by name, numbers by value and case aside', () => {
    assert.deepEqual(
      appsOfType(space, docs10, 'alpha').map((each) => each.id),
      ['da', 'd2', 'd10'],
    )
  })

  it('lists an app alone of its type alone', () => {
    assert.deepEqual(
      appsOfType(space, tasks, 'alpha').map((each) => each.id),
      ['t'],
    )
  })

  it('keeps each app’s address', () => {
    assert.equal(appsOfType(space, graph, 'alpha')[0]?.href, '/space/alpha/app/g')
  })
})

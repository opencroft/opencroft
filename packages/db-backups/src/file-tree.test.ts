import assert from 'node:assert/strict'
import { relative, sep } from 'node:path'
import test from 'node:test'

import { dataDir, instanceKeyFile } from '@opencroft/instance'

import { BACKUP_FILE_ROOTS } from './file-tree'

// A backup must not carry the instance keys: anyone holding the archive could
// then decrypt the secrets stored in it and sign sessions. The key file sits
// in the data directory, so this holds only while no root a backup archives
// contains it.
test('no data directory root a backup archives holds the instance key file', () => {
  const keyFile = relative(dataDir(), instanceKeyFile())
  assert.equal(keyFile, 'instance-secrets.json', 'the key file sits at the top of the data directory')
  assert.ok(
    BACKUP_FILE_ROOTS.some((root) => root.name === 'app-data'),
    'the roots are the real list',
  )
  for (const root of BACKUP_FILE_ROOTS) {
    assert.ok(
      keyFile !== root.name && !keyFile.startsWith(`${root.name}${sep}`),
      `the backup root ${root.name} must not hold the key file`,
    )
  }
})

// Without the package's `legacy.ts`, which names it tags is unknown: a
// deprecated use is still reported, with its names but no claim about where
// each lives or whether the package has it at all.
import assert from 'node:assert/strict'
import { promises as fs } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import test, { after, mock } from 'node:test'

import { scanDeprecatedApiUses } from './extension-api-deprecations'

const root = await fs.mkdtemp(path.join(os.tmpdir(), 'ext-api-deprecations-'))

after(async () => {
  await fs.rm(root, { recursive: true, force: true })
})

test('an unreadable legacy.ts drops the module names, not the names', async () => {
  await fs.mkdir(path.join(root, 'src'))
  await fs.writeFile(path.join(root, 'src/client.tsx'), "import { NodeFrame, notAHostName } from '@ext/host'\n")
  const readFile = fs.readFile.bind(fs)
  // The tags are read once per process, so this file's only scan is the one
  // that meets the unreadable file.
  const read = mock.method(fs, 'readFile', (file: Parameters<typeof fs.readFile>[0], options: 'utf-8') =>
    path.basename(String(file)) === 'legacy.ts'
      ? Promise.reject(Object.assign(new Error('ENOENT'), { code: 'ENOENT' }))
      : readFile(file, options),
  )
  const log = mock.method(console, 'warn', () => {})
  try {
    const found = await scanDeprecatedApiUses(root, [{ side: 'client', files: ['src/client.tsx'] }])
    assert.ok(
      log.mock.calls.some((call) =>
        /legacy\.ts unreadable, deprecations name no modules/.test(String(call.arguments[0])),
      ),
      'the unreadable legacy.ts was what the scan met',
    )
    assert.deepEqual(found, [
      {
        file: 'src/client.tsx',
        line: 1,
        used: '`@ext/host`',
        replacement: 'import `NodeFrame`, `notAHostName` each from its module of `@opencroft/client`',
      },
    ])
  } finally {
    read.mock.restore()
    log.mock.restore()
  }
})

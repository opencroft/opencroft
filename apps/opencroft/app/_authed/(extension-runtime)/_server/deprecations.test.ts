import assert from 'node:assert/strict'
import test, { mock } from 'node:test'

import { logDeprecations } from './deprecations'

test('the server log locates each deprecation as compile_extension does', () => {
  const log = mock.method(console, 'warn', () => {})
  try {
    logDeprecations('local.sample', [
      { file: 'extension.json', used: '`kind`', replacement: 'use `type`' },
      {
        file: 'src/client.tsx',
        line: 3,
        column: 7,
        used: '`@ext/ui`',
        replacement: 'import from `@opencroft/client/ui`',
      },
    ])
    assert.equal(log.mock.callCount(), 1)
    assert.equal(
      log.mock.calls[0].arguments[0],
      [
        '[ext] local.sample: 2 deprecated use(s):',
        '  extension.json  `kind` is deprecated: use `type`',
        '  src/client.tsx:3:7  `@ext/ui` is deprecated: import from `@opencroft/client/ui`',
      ].join('\n'),
    )
  } finally {
    log.mock.restore()
  }
})

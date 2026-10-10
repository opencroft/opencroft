// Which files count as installed. Pinned against both ways an alias resolves
// here — a tsconfig `paths` entry and a workspace package's `exports` — and
// against the shapes a looser reading gets wrong: a test file inside an
// installed directory, a sibling directory sharing the prefix, an alias that
// resolves nowhere.
import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import test from 'node:test'

import { installDirectories, parseJsonc, partitionInstalled } from './installed.mjs'

function scratch(files: Record<string, string>) {
  const root = mkdtempSync(path.join(tmpdir(), 'dev-tools-installed-'))
  for (const [file, content] of Object.entries(files)) {
    mkdirSync(path.dirname(path.join(root, file)), { recursive: true })
    writeFileSync(path.join(root, file), content)
  }
  return root
}

const components = (aliases: Record<string, string>) => JSON.stringify({ aliases })

test('tsconfig with comments and trailing commas parses, and comment markers inside strings survive', () => {
  const parsed = parseJsonc('{\n  // a comment\n  "a": "http://x/*y*/", /* block */\n  "b": [1, 2,],\n}\n')
  assert.deepEqual(parsed, { a: 'http://x/*y*/', b: [1, 2] })
})

test('an extension: ui, hooks and the kit hooks directory resolve through the tsconfig paths of the components.json directory', () => {
  const root = scratch({
    'components.json': components({
      components: '@/components',
      ui: '@/components/ui',
      hooks: '@/hooks',
      lib: '@/lib',
    }),
    'tsconfig.json': '{ "compilerOptions": { "baseUrl": ".", "paths": { "@/*": ["./src/*"] } } }',
  })
  try {
    assert.deepEqual(
      installDirectories(root, ['components.json']).map(({ alias, dir }) => [alias, dir]),
      [
        ['ui', 'src/components/ui'],
        ['hooks', 'src/hooks'],
        ['components/hooks', 'src/components/hooks'],
      ],
    )
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('a monorepo: an alias naming a workspace package resolves through that package’s exports', () => {
  const root = scratch({
    'package.json': JSON.stringify({ workspaces: ['packages/*'] }),
    'packages/ui/package.json': JSON.stringify({
      name: 'ui',
      exports: { './components/*': './src/components/*.tsx', './hooks/*': './src/hooks/*.ts', './*': './src/x/*.tsx' },
    }),
    'packages/ui/components.json': components({
      components: 'ui/components',
      ui: 'ui/components/ui',
      hooks: 'ui/hooks',
    }),
    'packages/ui/tsconfig.json': '{ "extends": "../../tsconfig.base.json" }',
    'tsconfig.base.json': '{ "compilerOptions": {} }',
  })
  try {
    assert.deepEqual(
      installDirectories(root, ['packages/ui/components.json']).map(({ dir }) => dir),
      ['packages/ui/src/components/ui', 'packages/ui/src/hooks', 'packages/ui/src/components/hooks'],
    )
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('paths inherited through a relative extends are used', () => {
  const root = scratch({
    'app/components.json': components({ ui: '~/ui' }),
    'app/tsconfig.json': '{ "extends": "./tsconfig.paths" }',
    'app/tsconfig.paths.json': '{ "compilerOptions": { "paths": { "~/*": ["./lib/*"] } } }',
  })
  try {
    assert.deepEqual(
      installDirectories(root, ['app/components.json']).map(({ dir }) => dir),
      ['app/lib/ui'],
    )
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('an alias that resolves nowhere is an error, not a silently linted directory', () => {
  const root = scratch({ 'components.json': components({ ui: '@nowhere/ui' }) })
  try {
    assert.throws(() => installDirectories(root, ['components.json']), /resolves through neither/)
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('files under an installed directory are installed, except tests; a sibling sharing the prefix is not', () => {
  const root = scratch({
    'components.json': components({ ui: '@/components/ui', hooks: '@/hooks' }),
    'tsconfig.json': '{ "compilerOptions": { "paths": { "@/*": ["./src/*"] } } }',
  })
  try {
    const files = [
      'components.json',
      'src/components/ui/button.tsx',
      'src/components/ui/layout/flex.tsx',
      'src/components/ui/layout/flex.test.tsx',
      'src/components/ui-extra/own.tsx',
      'src/components/own.tsx',
      'src/hooks/use-mobile.ts',
      'src/lib/utils.ts',
    ]
    const { installed, own } = partitionInstalled(root, files)
    assert.deepEqual(installed, [
      'src/components/ui/button.tsx',
      'src/components/ui/layout/flex.tsx',
      'src/hooks/use-mobile.ts',
    ])
    assert.deepEqual(own, [
      'components.json',
      'src/components/ui/layout/flex.test.tsx',
      'src/components/ui-extra/own.tsx',
      'src/components/own.tsx',
      'src/lib/utils.ts',
    ])
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('a repository with no components.json has nothing installed', () => {
  const root = scratch({ 'src/a.ts': '' })
  try {
    assert.deepEqual(partitionInstalled(root, ['src/a.ts']).installed, [])
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

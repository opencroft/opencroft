// The sibling of host-api-surface, and the half it cannot see.
//
// That file pins the generated shims against the host objects, so the RUNTIME
// an extension gets cannot disagree with what the host offers. It says nothing
// about types, because the shims it builds are JavaScript.
//
// The declarations live in `packages/client` and `packages/server`, one file
// per module. This file holds three descriptions of the extension API
// together: what each module declares, what the host serves under that module
// at run time, and the generated deprecated surface (`legacy`, `@ext/host`,
// `@ext/ui`), which re-exports every old name from the module that owns it.
//
// Read through the type checker rather than the parser: the `ui` module
// arrives by `export *` from another package, and following that by hand is a
// resolver reimplementation that would be wrong in exactly the places that
// matter.
import assert from 'node:assert/strict'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import test from 'node:test'

import ts from 'typescript'

import {
  extensionClientModules,
  extensionHostApi,
  extensionUiApi,
} from '@/app/_authed/(extension-runtime)/_client/host'
import { SERVER_MODULES, serverModuleNames } from './extension-api-modules'
import { createHost } from './host'
import { bindableNames, extensionScopedExports } from './host-shims'
import {
  packageModules,
  readModuleExports,
  renderLegacyDeclarations,
  repoPath,
  UNDECLARED_BY_DESIGN,
} from './legacy-declarations'

const client = readModuleExports('client')
const server = readModuleExports('server')
const scoped = extensionScopedExports('acme.probe')

const sorted = (names: Iterable<string>) => [...names].sort()

// Controls first. Every set below is read out of machinery this file does not
// own, and one arriving empty — a tsconfig that resolved nothing, an object
// that failed to load — would satisfy an equality without checking anything.
test('CONTROL: the module declarations are actually being read', () => {
  assert.ok(client.canvas.values.includes('NodeFrame'), 'canvas declares NodeFrame')
  assert.ok(client.canvas.types.includes('ResolvedContext'), 'canvas declares the ResolvedContext type')
  // The `export *` hop: this one comes from the ui package, not from a file
  // of packages/client, so its absence would mean the checker stopped early.
  assert.ok(client.ui.values.includes('Button'), 'the ui module re-exports the kit')
  assert.ok(server.graph.values.includes('graph'), 'the server graph module declares graph')
})

test('CONTROL: the runtime surface is actually being read', () => {
  assert.ok(bindableNames(extensionClientModules.canvas).includes('NodeFrame'))
  assert.ok(bindableNames(extensionClientModules.ui).includes('Button'))
  assert.ok(bindableNames(extensionHostApi).includes('defineExtension'))
  assert.ok(Object.keys(createHost('acme.probe')).includes('graph'))
})

test('the client package exports exactly the modules the host serves', () => {
  assert.deepEqual(packageModules('client'), sorted(Object.keys(extensionClientModules)))
})

test('each client module declares exactly the values the host serves under it', () => {
  for (const [module, runtime] of Object.entries(extensionClientModules)) {
    const served = [
      ...bindableNames(runtime),
      ...scoped.filter((entry) => entry.module === module).map((entry) => entry.name),
    ]
    assert.deepEqual(
      client[module].values,
      sorted(served),
      `@opencroft/client/${module}: the declared values and the values the host serves differ`,
    )
  }
})

test('the server package exports exactly the modules of the module map', () => {
  assert.deepEqual(packageModules('server'), sorted(Object.keys(SERVER_MODULES)))
})

test('each server module declares exactly the host members it is mapped to', () => {
  for (const [module, names] of Object.entries(SERVER_MODULES)) {
    assert.deepEqual(
      server[module].values,
      sorted(names),
      `@opencroft/server/${module}: the declared values and the host members it serves differ`,
    )
  }
})

test('every member of the server host belongs to a module, except the raw database', () => {
  // `db` is the host's own drizzle connection: reachable as `host.db` for
  // code written against the flat host, and never part of the declared API.
  const members = Object.keys(createHost('acme.probe')).filter((name) => name !== 'db')
  assert.deepEqual(sorted(members), sorted(serverModuleNames()))
})

test('the names excused from every module are on the runtime surface and declared by none', () => {
  const runtime = new Set([...bindableNames(extensionHostApi), ...bindableNames(extensionUiApi)])
  const declared = new Set(Object.values(client).flatMap(({ values, types }) => [...values, ...types]))
  for (const name of UNDECLARED_BY_DESIGN.keys()) {
    assert.ok(runtime.has(name), `${name} is excused but no longer on the runtime surface; drop the excuse`)
    assert.ok(!declared.has(name), `${name} is excused but a module declares it; drop the excuse`)
  }
})

test('code on the deprecated modules typechecks against them, and an editor strikes each name through', () => {
  // What an extension typecheck and an editor read: the generated
  // declarations, with a file importing from both old modules and from the
  // `legacy` namespace, client and server style.
  const probeDir = mkdtempSync(path.join(repoPath('apps/opencroft'), '.legacy-probe-'))
  try {
    const probe = path.join(probeDir, 'probe.ts')
    writeFileSync(
      probe,
      [
        "import host, { getStream, NodeFrame, type ResolvedContext, toast } from '@ext/host'",
        "import { Button } from '@ext/ui'",
        "import { legacy } from '@opencroft/client'",
        '',
        'export const wired: ResolvedContext | null = null',
        "export const read = [NodeFrame, Button, getStream('a', 'b'), legacy.Markdown, host.graph.listNodes()]",
        "toast('done')",
        '',
      ].join('\n'),
    )
    const files = [probe, repoPath('packages/client/ext-modules.d.ts')]
    const options: ts.CompilerOptions = {
      module: ts.ModuleKind.ESNext,
      moduleResolution: ts.ModuleResolutionKind.Bundler,
      target: ts.ScriptTarget.ES2022,
      jsx: ts.JsxEmit.ReactJSX,
      strict: true,
      noEmit: true,
      skipLibCheck: true,
      esModuleInterop: true,
      types: ['node', 'vite/client'],
    }
    const service = ts.createLanguageService({
      getScriptFileNames: () => files,
      getScriptVersion: () => '1',
      getScriptSnapshot: (file) =>
        ts.sys.fileExists(file) ? ts.ScriptSnapshot.fromString(ts.sys.readFile(file) ?? '') : undefined,
      getCurrentDirectory: () => probeDir,
      getCompilationSettings: () => options,
      getDefaultLibFileName: ts.getDefaultLibFilePath,
      fileExists: ts.sys.fileExists,
      readFile: ts.sys.readFile,
      readDirectory: ts.sys.readDirectory,
      directoryExists: ts.sys.directoryExists,
      getDirectories: ts.sys.getDirectories,
    })
    const errors = service
      .getSemanticDiagnostics(probe)
      .map((diagnostic) => ts.flattenDiagnosticMessageText(diagnostic.messageText, '\n'))
    assert.deepEqual(errors, [], 'the deprecated modules must typecheck code that uses them')

    const struck = new Set(
      service
        .getSuggestionDiagnostics(probe)
        .filter((diagnostic) => diagnostic.reportsDeprecated)
        .map((diagnostic) => ts.flattenDiagnosticMessageText(diagnostic.messageText, '\n').match(/'(\w+)'/)?.[1]),
    )
    for (const name of ['host', 'getStream', 'NodeFrame', 'ResolvedContext', 'toast', 'Button', 'legacy', 'Markdown']) {
      assert.ok(struck.has(name), `${name} must be reported deprecated; got ${[...struck].join(', ')}`)
    }
  } finally {
    rmSync(probeDir, { recursive: true, force: true })
  }
})

test('the generated deprecated surface is current', () => {
  // Rendering also accounts for every name the old flat surface serves: one
  // that no module declares and nothing retires stops it with that name.
  for (const file of renderLegacyDeclarations()) {
    assert.equal(
      readFileSync(repoPath(file.path), 'utf-8'),
      file.content,
      `${file.path} is stale: run \`npm run generate:legacy-declarations -w apps/opencroft\``,
    )
  }
})

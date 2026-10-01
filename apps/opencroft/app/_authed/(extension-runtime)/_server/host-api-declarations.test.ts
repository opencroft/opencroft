// The sibling of host-api-surface, and the half it cannot see.
//
// That file pins the generated shim against the host objects, so the RUNTIME
// an extension gets cannot disagree with what the host offers. It says nothing
// about types, because the shim it builds is JavaScript.
//
// The declarations live somewhere else entirely: `packages/client`, whose own
// header calls itself the ported surface. Nothing has ever compared the two.
// So "the typed spelling covers the surface" has been a claim about a file
// rather than a measured property of it, and a per-repository typecheck built
// on that claim would certify green against declarations that lie -- which is
// the failure this whole line of work is about, turned on its own fix.
//
// Read through the type checker rather than the parser: the declared surface
// arrives partly by `export *` from other packages, and following those by
// hand is a resolver reimplementation that would be wrong in exactly the
// places that matter.
import assert from 'node:assert/strict'
import path from 'node:path'
import test from 'node:test'
import { fileURLToPath } from 'node:url'

import ts from 'typescript'

import { extensionHostApi, extensionUiApi } from '@/app/_authed/(extension-runtime)/_client/host'
import { bindableNames, extensionScopedExports } from './compiler'

const here = path.dirname(fileURLToPath(import.meta.url))
// _server -> (extension-runtime) -> _authed -> app -> apps/opencroft -> apps -> the repo root.
const repoRoot = path.resolve(here, '../../../../../..')
const CLIENT_ENTRY = path.join(repoRoot, 'packages/client/src/index.ts')
const CLIENT_TSCONFIG = path.join(repoRoot, 'packages/client/tsconfig.json')

/**
 * Every name `@opencroft/client` declares, at its root or under `legacy`.
 *
 * Both halves count: the package deliberately graduates names out of `legacy`
 * into the root over time, so a name that moved is still declared and a check
 * that looked in only one place would fail on the migration it exists to
 * support.
 */
function declaredNames(): Set<string> {
  const configFile = ts.readConfigFile(CLIENT_TSCONFIG, ts.sys.readFile)
  assert.equal(configFile.error, undefined, 'the client package tsconfig must parse')
  const parsed = ts.parseJsonConfigFileContent(configFile.config, ts.sys, path.dirname(CLIENT_TSCONFIG))

  const program = ts.createProgram([CLIENT_ENTRY], parsed.options)
  const checker = program.getTypeChecker()
  const entry = program.getSourceFile(CLIENT_ENTRY)
  assert.ok(entry, 'the client package entry must be in the program')

  const moduleSymbol = checker.getSymbolAtLocation(entry)
  assert.ok(moduleSymbol, 'the entry must resolve as a module symbol')

  const names = new Set<string>()
  for (const symbol of checker.getExportsOfModule(moduleSymbol)) {
    names.add(symbol.getName())
    if (symbol.getName() !== 'legacy') {
      continue
    }
    // `export * as legacy from './legacy'` — the root export is an alias to
    // the module, so its members are one resolution away rather than in hand.
    const target = symbol.flags & ts.SymbolFlags.Alias ? checker.getAliasedSymbol(symbol) : symbol
    for (const member of checker.getExportsOfModule(target)) {
      names.add(member.getName())
    }
  }
  return names
}

/**
 * Every name an extension can bind from the host, by the compiler's own
 * definition of bindable rather than a copy of it.
 *
 * Three sources, because the shim has three: the host object, the UI object,
 * and the handful the shim declares itself because each is bound to the
 * extension being built.
 */
function surfaceNames(): Set<string> {
  return new Set([
    ...bindableNames(extensionHostApi),
    ...bindableNames(extensionUiApi),
    // The id is arbitrary — only the names are read, and they do not vary.
    ...extensionScopedExports('acme.probe').map((entry) => entry.name),
  ])
}

/**
 * Names on the runtime surface that `packages/client` deliberately does not
 * declare. Every entry needs a reason, and "we have not got to it yet" is not
 * one — that is what this test is for.
 */
const UNDECLARED_BY_DESIGN = new Map<string, string>([
  [
    'callAction',
    'The raw form of `invoke`, taking the extension id as its first argument. The shim declares `invoke` itself, bound to the extension being built, precisely so an extension never names itself — declaring this would advertise the unbound one beside it.',
  ],
  ['callNodeAction', 'The raw form of `dispatch`, and bound the same way for the same reason.'],
  [
    'extensionUrl',
    'The raw form of `assetUrl` and `routeUrl`, taking the extension id as its first argument. The shim binds those two to the extension being built, so an extension never spells its own id or path prefix.',
  ],
])

const declared = declaredNames()
const surface = surfaceNames()

// Controls first. Both sets are read out of machinery this file does not own,
// and either one arriving empty — a tsconfig that resolved nothing, a host
// object that failed to load — satisfies the assertion below without checking
// anything at all.
test('CONTROL: the declarations are actually being read', () => {
  assert.ok(declared.size > 100, `expected a substantial declared surface; read ${declared.size} names`)
  for (const name of ['React', 'icons', 'invoke', 'NodeFrame', 'defineExtension']) {
    assert.ok(declared.has(name), `${name} is declared in the client package and must be found`)
  }
  // The `export *` hop specifically: this one arrives from the ui package
  // rather than from either file of `packages/client`, so its absence would
  // mean the checker resolved the local file and stopped.
  assert.ok(
    declared.has('Button'),
    'the re-exported component surface must be followed, not just the local declarations',
  )
})

test('CONTROL: the runtime surface is actually being read', () => {
  assert.ok(surface.size > 50, `expected a substantial host surface; read ${surface.size} names`)
  for (const name of ['React', 'defineExtension', 'invoke', 'createStorage']) {
    assert.ok(surface.has(name), `${name} is on the host surface and must be found`)
  }
})

test('CONTROL: a name on neither side is reported as neither', () => {
  const invented = 'thisIsNotAHostApiName'
  assert.ok(!declared.has(invented), 'the declared set must not match an invented name')
  assert.ok(!surface.has(invented), 'the surface set must not match an invented name')
})

test('every name an extension can bind is declared by the client package', () => {
  const missing = [...surface].filter((name) => !declared.has(name) && !UNDECLARED_BY_DESIGN.has(name)).sort()
  assert.deepEqual(
    missing,
    [],
    `these names are reachable at runtime and have no declaration, so the typed spelling silently lacks them:\n  ${missing.join('\n  ')}`,
  )
})

test('the exclusion list holds nothing that is declared after all', () => {
  const stale = [...UNDECLARED_BY_DESIGN.keys()].filter((name) => declared.has(name)).sort()
  assert.deepEqual(stale, [], 'an entry excused here is now declared — remove it rather than leaving a false exception')
})

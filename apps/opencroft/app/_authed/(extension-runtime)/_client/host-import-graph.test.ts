// The host's client surface is what anything asks when it wants to know what
// the host offers -- including runtimes that never draw anything: the
// extension compiler under bare `tsx`, and the suites for the right sidebar,
// the node canvas and the host API itself. While `host.ts` imported the graph
// surface statically, that question dragged the whole editor subtree behind
// it -- graph-canvas -> space-canvas -> flow-editor -> @xyflow/react's
// stylesheet -- and all three suites failed to LOAD, with
// ERR_UNKNOWN_FILE_EXTENSION, because Node has no CSS loader.
//
// Those suites going green is deliberately NOT what this file pins. A `.css`
// stub in the test setup buys exactly the same green while leaving the
// coupling untouched, so a green suite cannot tell the fix from the
// workaround. The property is the EDGE: asking the host what it offers must
// not reach the editor. That is what is asserted here, by walking the static
// import graph.
import assert from 'node:assert/strict'
import { existsSync, readFileSync, statSync } from 'node:fs'
import path from 'node:path'
import test from 'node:test'
import { fileURLToPath } from 'node:url'

import ts from 'typescript'

const here = path.dirname(fileURLToPath(import.meta.url))
// _client -> (extension-runtime) -> _authed -> app -> the app root, which is
// what tsconfig maps `@/*` onto.
const appRoot = path.resolve(here, '../../../..')

const HOST = path.join(appRoot, 'app/_authed/(extension-runtime)/_client/host.ts')
const SPACE_CANVAS = path.join(appRoot, 'app/_authed/(space)/_components/space-canvas.tsx')
const FLOW_EDITOR = path.join(appRoot, 'app/_authed/(dashboard)/_canvas/flow-editor.tsx')
const MARKDOWN_EDITOR = path.join(appRoot, 'components/markdown-editor.tsx')

interface Graph {
  /** Every file inside this app reachable from the entry by static import. */
  files: Set<string>
  /** Bare specifiers reached -- packages, which are leaves here. */
  externals: Set<string>
}

/**
 * The specifiers of a module's STATIC imports.
 *
 * Read off the real TypeScript parser rather than matched out of the text,
 * because the distinction this file exists to assert is the one a regular
 * expression is worst at: `import(...)` is a separate chunk and NOT an edge in
 * this graph, while `import ... from` is. A pattern loose enough to catch
 * every static form catches the dynamic one too, and would go on reporting the
 * edge after it was cut -- failing the fix and passing the workaround, which
 * is precisely backwards. Type-only imports are erased before Node sees them,
 * so they are not edges either.
 */
function staticImportsOf(file: string): string[] {
  const source = ts.createSourceFile(
    file,
    readFileSync(file, 'utf-8'),
    ts.ScriptTarget.Latest,
    false,
    file.endsWith('.tsx') ? ts.ScriptKind.TSX : ts.ScriptKind.TS,
  )
  const specifiers: string[] = []
  for (const statement of source.statements) {
    if (ts.isImportDeclaration(statement)) {
      // `import 'x'` has no import clause at all and is still an edge -- that
      // is the shape a stylesheet arrives in.
      if (statement.importClause?.isTypeOnly) {
        continue
      }
    } else if (ts.isExportDeclaration(statement)) {
      if (statement.isTypeOnly || !statement.moduleSpecifier) {
        continue
      }
    } else {
      continue
    }
    const specifier = statement.moduleSpecifier
    if (specifier && ts.isStringLiteral(specifier)) {
      specifiers.push(specifier.text)
    }
  }
  return specifiers
}

/**
 * Resolve a specifier to a file in this app, or null when it is a package.
 *
 * Only two kinds of specifier reach a file here: the app's own `@/` alias
 * (tsconfig maps `@/*` to the app root) and a relative path. Everything else
 * is a dependency, and a dependency is a leaf -- the question is what the APP
 * pulls in, and another package's graph is not this app's to answer for.
 */
function resolveInApp(specifier: string, fromFile: string): string | null {
  let base: string
  if (specifier.startsWith('@/')) {
    base = path.join(appRoot, specifier.slice(2))
  } else if (specifier.startsWith('.')) {
    base = path.resolve(path.dirname(fromFile), specifier)
  } else {
    return null
  }
  const candidates = [base, `${base}.ts`, `${base}.tsx`, path.join(base, 'index.ts'), path.join(base, 'index.tsx')]
  for (const candidate of candidates) {
    if (existsSync(candidate) && statSync(candidate).isFile()) {
      return candidate
    }
  }
  return null
}

function walkFrom(entry: string): Graph {
  const files = new Set<string>()
  const externals = new Set<string>()
  const queue = [entry]
  while (queue.length > 0) {
    const file = queue.pop() as string
    if (files.has(file)) {
      continue
    }
    files.add(file)
    // A stylesheet is reached, recorded, and not parsed: it has no imports to
    // read and TypeScript cannot make a source file of one.
    if (!/\.tsx?$/.test(file)) {
      continue
    }
    for (const specifier of staticImportsOf(file)) {
      const resolved = resolveInApp(specifier, file)
      if (resolved === null) {
        externals.add(specifier)
      } else {
        queue.push(resolved)
      }
    }
  }
  return { files, externals }
}

const fromHost = walkFrom(HOST)

// The control, and it carries this file. An absence proves nothing about the
// code until the same instrument is shown finding the thing when it IS there:
// a walker that resolved nothing -- a wrong app root, an alias it does not
// understand, a parser handed the wrong ScriptKind -- returns an empty set,
// and every assertion below it passes on that. space-canvas is the module the
// host used to reach, one hop above the editor, and it still imports it
// directly, so it stays a live example of the edge for as long as the editor
// has a parent at all.
test('CONTROL: the walker finds the editor when the edge is really there', () => {
  const fromSpaceCanvas = walkFrom(SPACE_CANVAS)
  assert.ok(
    fromSpaceCanvas.files.has(FLOW_EDITOR),
    'walking from space-canvas must reach the flow editor -- if it does not, this file cannot see edges at all',
  )
  assert.ok(
    [...fromSpaceCanvas.files].some((f) => f.endsWith('.css')),
    'and must reach a stylesheet through it, which is the specific thing Node could not load',
  )
})

// The bound, controlled separately from the pattern. The assertions below say
// "not in this set", and they are satisfied just as well by a set that is
// empty because the walk stopped at its first file.
test('CONTROL: the walk from the host actually covers the host graph', () => {
  assert.ok(fromHost.files.has(HOST), 'the entry is in its own graph')
  assert.ok(fromHost.files.size > 50, `the host's graph should be substantial; walked ${fromHost.files.size} files`)
  assert.ok(
    fromHost.externals.has('@xyflow/react'),
    'the host does still use xyflow directly, for handles and hooks -- externals are being collected',
  )
})

// The same property for Monaco, which arrives by a different route and costs
// something different. `@/components/code-editor` IS statically in this graph
// and has to be — it is what `legacy.CodeEditor` hands extensions — but it
// reaches Monaco's runtime through a dynamic `import()`, so `monaco-editor`
// itself is not an edge. Two things ride on that. Node: monaco's ESM imports
// stylesheets, so a static edge would put this app's host surface back out of
// reach of every runtime without a CSS loader, which is the failure the whole
// file is about. Browser: monaco is megabytes, and the surfaces that pull the
// host surface in are ones that merely might show code rather than ones that
// do.
//
// The pair of assertions is the point. Dropping the editor out of the host
// graph entirely would satisfy "no monaco-editor" just as well as deferring it,
// so the presence of the wrapper is asserted alongside the absence of what it
// wraps.
test('asking the host what it offers does not reach monaco itself', () => {
  assert.ok(
    fromHost.externals.has('@monaco-editor/react'),
    "the host does still offer the editor component -- if it does not, the next assertion isn't about anything",
  )
  assert.deepEqual(
    [...fromHost.externals].filter(
      (specifier) => specifier === 'monaco-editor' || specifier.startsWith('monaco-editor/'),
    ),
    [],
    "monaco's runtime must stay behind the dynamic import in code-editor.tsx -- see ./monaco-runtime",
  )
})

// The same property a third time, for the markdown WYSIWYG.
// `@/components/markdown-editor` IS statically in this graph -- it is what
// `MarkdownEditor` hands extensions -- while the module it wraps, and the
// TipTap and ProseMirror tree behind that, sit behind a `lazy(() => import())`.
// The cost is the browser's rather than Node's: the surfaces that ask the host
// what it offers are ones that merely might show an extension, and almost none
// of them edit markdown.
//
// A pair again, for the Monaco test's reason: deleting the wrapper satisfies
// "the editor module is not imported" exactly as well as deferring it does.
test('asking the host what it offers does not reach the markdown editor module', () => {
  assert.ok(
    fromHost.files.has(MARKDOWN_EDITOR),
    "the host does still offer the editor wrapper -- if it does not, the next assertion isn't about anything",
  )
  assert.deepEqual(
    [...fromHost.externals].filter((specifier) => specifier.startsWith('agent-chat/markdown-editor')),
    [],
    'TipTap must stay behind the dynamic import in components/markdown-editor.tsx',
  )
})

test('asking the host what it offers does not reach the flow editor', () => {
  assert.ok(
    !fromHost.files.has(FLOW_EDITOR),
    'host.ts must not statically import the flow editor -- reach the graph surface lazily instead',
  )
})

// The name carries the bound on purpose. This walk stops at package
// boundaries -- `resolveInApp` returns null for every bare specifier, so a
// stylesheet imported INSIDE a workspace package is invisible to it, and a name
// like "nothing in the host graph" would promise more than the walk delivers to
// whoever reads the next failure. The host reaches `ui/` this way, so the blind
// spot is real rather than theoretical; what makes it survivable is that the
// kit's sources import no stylesheet, which is a property of `packages/ui` and
// belongs to a check that lives there.
test("no file in this app's half of the host graph pulls in a stylesheet", () => {
  // Both halves of what this walk CAN see, because a stylesheet arrives two
  // ways and only one of them is a file in this app: `import '@/....css'`
  // resolves locally, and `import '@xyflow/react/dist/style.css'` is a bare
  // specifier that never does. Checking only the resolved files would miss the
  // exact import that caused this.
  const localCss = [...fromHost.files].filter((f) => f.endsWith('.css')).map((f) => path.relative(appRoot, f))
  const packageCss = [...fromHost.externals].filter((specifier) => specifier.endsWith('.css'))
  assert.deepEqual(
    [...localCss, ...packageCss],
    [],
    'a runtime with no CSS loader must be able to import the host surface',
  )
})

import { loader } from '@monaco-editor/react'
import * as monaco from 'monaco-editor'
import EditorWorker from 'monaco-editor/esm/vs/editor/editor.worker.js?worker'
import CssWorker from 'monaco-editor/esm/vs/language/css/css.worker.js?worker'
import HtmlWorker from 'monaco-editor/esm/vs/language/html/html.worker.js?worker'
import JsonWorker from 'monaco-editor/esm/vs/language/json/json.worker.js?worker'
import TsWorker from 'monaco-editor/esm/vs/language/typescript/ts.worker.js?worker'

// Monaco's runtime, from this app's own build.
//
// Importing this module IS downloading Monaco — everything below runs at module
// scope and the namespace import above is megabytes. Nothing may import it
// statically; code-editor.tsx reaches it through one dynamic `import()` and is
// the only thing that does. See `loadMonacoRuntime` there for why.
//
// What this replaces: @monaco-editor/loader, left unconfigured, injects
// `loader.js` from a public CDN at run time and that script then AMD-loads
// `editor.api`, `editor.main.css` and a worker per language service — roughly
// 2.4 MB for a TSX editor, from a third party, on the critical path of every
// surface that shows code. Configuring the loader with an already-loaded
// namespace means `init()` resolves with it and no script is ever injected, so
// the version that runs is the one in this repo's lockfile rather than whatever
// the URL currently resolves to, and the bytes are content-hashed chunks from
// this origin — which matters here specifically, because our static responses
// carry no `cache-control`, `etag` or `last-modified` at all, and a hashed
// filename is the one cache key that does not need one.
//
// `monaco-editor` is a runtime dependency of this app for exactly this import,
// not a types-only devDependency: a deploy may install with `npm install` from inside
// apps/opencroft and a release install carries no devDependencies, so a build
// that imports it from there would resolve in every dev worktree and fail on the
// one install path that ships.

// ── Web workers ──────────────────────────────────────────────────────────────
//
// The AMD loader used to start these itself, from the same CDN directory it had
// just loaded the editor out of. A bundled Monaco has no loader to ask: it calls
// `MonacoEnvironment.getWorker(_, label)` and whatever comes back is the worker,
// so the bundler has to be told about each entry point by hand. Vite's `?worker`
// suffix builds each one as its own chunk and hands back a constructor for it.
//
// The labels are not free-form. `vs/common/workers.js` and
// `vs/base/browser/webWorkerFactory.js` both pass `descriptor.label` straight
// through: the language services set theirs from their own language id (the
// `LanguageServiceDefaults` registered by each `monaco.contribution`), and the
// editor's own worker is registered in `vs/editor/standalone/browser/
// standaloneServices.js` as `editorWorkerService`. Those are the cases below.
//
// Getting one wrong does not look broken, which is the reason this comment is
// as long as it is. The editor still renders, still colours text and still
// takes input — only diagnostics, completions, formatting, hovers and the diff
// computation stop happening, silently, with at most one console error at the
// moment the worker was needed. So `default` returns the editor worker rather
// than throwing or returning nothing: it is genuinely the right answer for
// every language without a dedicated service (Python, shell, the other eighty
// basic languages), which is most of what this app opens.
self.MonacoEnvironment = {
  getWorker(_workerId: string, label: string): Worker {
    switch (label) {
      case 'json':
        return new JsonWorker()
      case 'css':
      case 'scss':
      case 'less':
        return new CssWorker()
      case 'html':
      case 'handlebars':
      case 'razor':
        return new HtmlWorker()
      case 'typescript':
      case 'javascript':
        return new TsWorker()
      default:
        // `editorWorkerService` — links, word-based completions, and the diff
        // computation every DiffView depends on.
        return new EditorWorker()
    }
  },
}

// ── The loader ───────────────────────────────────────────────────────────────
//
// Recording only; it opens no connection. It has to happen before anything calls
// `loader.init()`, and after that point it is silently too late — `init()` sets
// `isInitialized` and returns the same promise forever, so a later `config` is
// written to a state nobody reads again. @monaco-editor/react calls `init()` from
// the editor's mount effect, which is why code-editor.tsx renders no editor until
// this module has finished loading.
//
// `monaco` here is the package's main entry, `esm/vs/editor/editor.main.js` —
// the whole language set, the same width the CDN bundle had. That is deliberate
// and not the narrower `editor.api.js`: callers compute a language id at run
// time from a file path (the git extension's `languageFromPath` alone reaches
// for about forty of them), and a language Monaco does not know is not an error,
// it is a file that quietly stops being coloured. The width is cheap because
// Monaco registers each basic language with a lazy loader, so the grammars
// become their own chunks and only the ones actually opened are fetched.
loader.config({ monaco })

import type { HighlighterCore } from 'shiki/core'
import { createHighlighterCore } from 'shiki/core'
import { createJavaScriptRegexEngine } from 'shiki/engine/javascript'

// Both themes are written into every token at once and chosen by CSS, so a
// light/dark switch re-paints nothing: shiki emits each colour as a custom
// property and the stylesheet decides which one is in force. Re-highlighting a
// transcript because somebody flipped the theme would be work proportional to
// the whole conversation for a change that is only ever visual.
export const LIGHT_THEME = 'github-light-default'
export const DARK_THEME = 'dark-plus'

// Oniguruma is deliberately not the engine. It is a 148 KB (gzipped) wasm
// payload, and this renders a conversation where most messages carry no code
// at all. The JavaScript engine compiles the same TextMate grammars to native
// RegExp; `forgiving` makes it skip the few patterns it cannot express instead
// of refusing the grammar outright, so a rare token keeps the default colour
// rather than a whole language losing its highlighting.
const engine = createJavaScriptRegexEngine({ forgiving: true })

// One grammar per dynamic import, so a conversation pays only for the
// languages it actually contains -- the full set is 8.6 MB unpacked. What is
// listed is what agent transcripts and our own documentation write; anything
// else renders as plain text, which is a plainer block and never a broken one.
const GRAMMARS: Record<string, () => Promise<unknown>> = {
  bash: () => import('@shikijs/langs/bash'),
  c: () => import('@shikijs/langs/c'),
  cpp: () => import('@shikijs/langs/cpp'),
  csharp: () => import('@shikijs/langs/csharp'),
  css: () => import('@shikijs/langs/css'),
  diff: () => import('@shikijs/langs/diff'),
  docker: () => import('@shikijs/langs/docker'),
  go: () => import('@shikijs/langs/go'),
  graphql: () => import('@shikijs/langs/graphql'),
  html: () => import('@shikijs/langs/html'),
  ini: () => import('@shikijs/langs/ini'),
  java: () => import('@shikijs/langs/java'),
  javascript: () => import('@shikijs/langs/javascript'),
  json: () => import('@shikijs/langs/json'),
  jsonc: () => import('@shikijs/langs/jsonc'),
  kotlin: () => import('@shikijs/langs/kotlin'),
  lua: () => import('@shikijs/langs/lua'),
  make: () => import('@shikijs/langs/make'),
  markdown: () => import('@shikijs/langs/markdown'),
  php: () => import('@shikijs/langs/php'),
  python: () => import('@shikijs/langs/python'),
  ruby: () => import('@shikijs/langs/ruby'),
  rust: () => import('@shikijs/langs/rust'),
  scss: () => import('@shikijs/langs/scss'),
  shellsession: () => import('@shikijs/langs/shellsession'),
  sql: () => import('@shikijs/langs/sql'),
  swift: () => import('@shikijs/langs/swift'),
  toml: () => import('@shikijs/langs/toml'),
  tsx: () => import('@shikijs/langs/tsx'),
  typescript: () => import('@shikijs/langs/typescript'),
  vue: () => import('@shikijs/langs/vue'),
  xml: () => import('@shikijs/langs/xml'),
  yaml: () => import('@shikijs/langs/yaml'),
}

// What a fence says versus what the grammar is called. Agents write `ts` and
// `sh` far more often than `typescript` and `bash`, and a fence we fail to
// recognise costs the reader the colours for no reason at all.
const ALIASES: Record<string, string> = {
  cjs: 'javascript',
  'c++': 'cpp',
  console: 'shellsession',
  cs: 'csharp',
  dockerfile: 'docker',
  golang: 'go',
  js: 'javascript',
  jsx: 'tsx',
  kt: 'kotlin',
  makefile: 'make',
  md: 'markdown',
  mdx: 'markdown',
  mjs: 'javascript',
  patch: 'diff',
  py: 'python',
  rb: 'ruby',
  rs: 'rust',
  sh: 'bash',
  shell: 'bash',
  ts: 'typescript',
  yml: 'yaml',
  zsh: 'bash',
}

/**
 * The language a fence names, as its author wrote it, or null for a fence that
 * names none.
 *
 * A fence's info string carries more than a language in the wild -- `ts {1,3}`,
 * `bash title="install"` -- so only the first word is read.
 */
export function fenceLanguage(info?: string): string | null {
  return info?.trim().split(/[\s:{]/)[0] || null
}

/** The grammar to highlight a fence with, or null when there is none to use. */
export function resolveLanguage(info?: string): string | null {
  const first = fenceLanguage(info)?.toLowerCase()
  if (!first) {
    return null
  }
  const name = ALIASES[first] ?? first
  return name in GRAMMARS ? name : null
}

// Created once for the page: every block shares one engine, one theme pair and
// one set of loaded grammars, so the second TypeScript block in a conversation
// costs nothing the first one has not already paid.
let core: Promise<HighlighterCore> | null = null
// The resolved instance, kept beside the promise it came from. A caller that
// renders HTML can await; one building a ProseMirror decoration set cannot,
// because decorations are produced inside a transaction where there is nowhere
// to suspend. `tokenize` answers from whatever has arrived and the caller asks
// again when `prepareLanguage` resolves.
let ready: HighlighterCore | null = null
// A plain object rather than a Map on purpose: the design kit's preview sandbox
// puts every lucide icon in scope by its bare name, and one of those icons is
// called `Map`, so `new Map()` is a TypeError in a preview and nowhere else.
// Nothing here needs Map's semantics, and a component that cannot be previewed
// is a component nobody can review.
const grammarLoads: Record<string, Promise<boolean>> = {}
// Which grammars finished loading, for the same synchronous caller: the promise
// in `grammarLoads` says a load was started, this says it can be used now.
const grammarsReady: Record<string, boolean> = {}

function highlighter(): Promise<HighlighterCore> {
  core ??= createHighlighterCore({
    themes: [import('@shikijs/themes/github-light-default'), import('@shikijs/themes/dark-plus')],
    langs: [],
    engine,
  }).then((instance) => {
    ready = instance
    return instance
  })
  return core
}

function loadGrammar(instance: HighlighterCore, name: string): Promise<boolean> {
  const pending = grammarLoads[name]
  if (pending) {
    return pending
  }
  // Cached including its failure: a grammar that could not be fetched once is
  // not worth re-fetching for every block in the conversation that uses it.
  const load = instance
    .loadLanguage(GRAMMARS[name]() as Parameters<HighlighterCore['loadLanguage']>[0])
    .then(() => {
      grammarsReady[name] = true
      return true
    })
    .catch(() => false)
  grammarLoads[name] = load
  return load
}

/**
 * The classes of a code block's `pre`, on the one `highlight` returns and on
 * the plain one a caller renders before it. The code scrolls sideways instead
 * of wrapping: a wrapped line of code loses the indentation the reader is
 * following. And the `pre` draws no box -- no margin, border, background or
 * rounding -- because the frame around it does, with the language over the
 * code. The classes travel with the markup, so a block looks the same wherever
 * it is installed, whichever stylesheet the host has.
 */
export const CODE_PRE_CLASS = 'm-0 rounded-none border-0 bg-transparent overflow-x-auto whitespace-pre'

export interface HighlightOptions {
  /**
   * Leave out the mark that gives a block its box, for a caller that draws its
   * own -- an editor layering a textarea over the highlighted text has to own
   * the padding and line height itself, because the caret only lands on the
   * right glyph while both elements agree on them exactly.
   */
  plain?: boolean
}

/**
 * The code as highlighted HTML, or null when it cannot be highlighted.
 *
 * Null is an ordinary answer and never an error: an unrecognised fence, a
 * grammar that fails to arrive and an engine that cannot run all mean the same
 * thing to the reader, which is that this block is plain text. The caller holds
 * the code and renders it either way -- highlighting is decoration, and a
 * decoration that fails must not cost anybody the thing being decorated.
 */
export async function highlight(
  code: string,
  language: string,
  options?: HighlightOptions,
): Promise<string | null> {
  try {
    const instance = await highlighter()
    if (!(await loadGrammar(instance, language))) {
      return null
    }
    return instance.codeToHtml(code, {
      lang: language,
      themes: { light: LIGHT_THEME, dark: DARK_THEME },
      defaultColor: false,
      // Marks the element as a code block's: it scrolls sideways rather than
      // wrapping, inside the frame that draws its box, and the mark is what
      // the stylesheet sets its padding and size on where no prose does. The
      // colours do not hang on it -- they hang on shiki's own class -- so a
      // caller that brings its own box still gets coloured text.
      transformers: options?.plain
        ? [
            {
              pre(node) {
                // The caller owns the typography here, and has to: a caret only
                // lands on the right glyph while the text under it and the text
                // being typed agree on font, size, line height and padding. The
                // user-agent stylesheet gives every `pre` a margin and a font of
                // its own, so they are overridden inline -- a stylesheet rule
                // would not travel with this file into the design kit.
                node.properties.style = `${node.properties.style ?? ''};margin:0;padding:0;background:transparent;font:inherit;line-height:inherit;`
              },
            },
          ]
        : [
            {
              pre(node) {
                node.properties['data-code-block'] = ''
                this.addClassToHast(node, CODE_PRE_CLASS)
              },
            },
          ],
    })
  } catch {
    return null
  }
}

/** One highlighted run of a code block, as offsets into the code it came from. */
export interface CodeToken {
  /** Offset of the run's first character. */
  start: number
  /** Offset one past its last character. */
  end: number
  /**
   * Both themes' colours as custom properties, ready for a `style` attribute --
   * the same pair `highlight` writes into its markup, so the same stylesheet
   * rule chooses between them.
   */
  style: string
}

/**
 * Load `language`'s grammar, resolving to whether it can now be tokenized.
 *
 * Separate from `tokenize` because the two callers need different shapes of the
 * same thing. Rendering HTML can await the grammar; a ProseMirror decoration
 * set is built inside a transaction, where there is nowhere to await -- so that
 * caller asks for what is ready, starts the load, and asks again here.
 */
export function prepareLanguage(language: string): Promise<boolean> {
  return highlighter()
    .then((instance) => loadGrammar(instance, language))
    .catch(() => false)
}

/**
 * The code's coloured runs, or null when nothing can be said about it yet.
 *
 * Synchronous on purpose, and null is an ordinary answer: an engine that has
 * not finished starting, a grammar still in flight and a grammar that failed to
 * arrive all mean the same thing to the caller, which is that this block is
 * plain text for now. Runs that carry no colour are left out rather than
 * returned empty, so a caller decorating a document adds nothing for them.
 */
export function tokenize(code: string, language: string): CodeToken[] | null {
  return tokensOf(code, language)
}

/**
 * The code's coloured runs for a fence's info string (`ts`, `json title="a"`),
 * once its grammar has arrived; null when the fence names no grammar there is
 * to use. The asynchronous counterpart of `tokenize`, for a caller that renders
 * rather than decorates -- a diff colouring each version of a code block in
 * its own fence's language.
 */
export async function codeColours(code: string, info: string): Promise<CodeToken[] | null> {
  const language = resolveLanguage(info)
  if (!language || !(await prepareLanguage(language))) {
    return null
  }
  return tokensOf(code, language)
}

function tokensOf(code: string, language: string): CodeToken[] | null {
  const instance = ready
  if (!instance || !grammarsReady[language]) {
    return null
  }
  try {
    const { tokens } = instance.codeToTokens(code, {
      lang: language,
      themes: { light: LIGHT_THEME, dark: DARK_THEME },
      defaultColor: false,
    })
    const runs: CodeToken[] = []
    for (const line of tokens) {
      for (const token of line) {
        const declarations = Object.entries(token.htmlStyle ?? {})
          .map(([property, colour]) => `${property}:${colour}`)
          .join(';')
        if (!declarations || !token.content) {
          continue
        }
        runs.push({ start: token.offset, end: token.offset + token.content.length, style: declarations })
      }
    }
    return runs
  } catch {
    return null
  }
}

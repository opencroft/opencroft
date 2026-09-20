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
 * The grammar to highlight a fence with, or null when there is none to use.
 *
 * A fence's info string carries more than a language in the wild -- `ts {1,3}`,
 * `bash title="install"` -- so only the first word is read.
 */
export function resolveLanguage(info?: string): string | null {
  if (!info) {
    return null
  }
  const first = info.trim().toLowerCase().split(/[\s:{]/)[0]
  const name = ALIASES[first] ?? first
  return name in GRAMMARS ? name : null
}

// Created once for the page: every block shares one engine, one theme pair and
// one set of loaded grammars, so the second TypeScript block in a conversation
// costs nothing the first one has not already paid.
let core: Promise<HighlighterCore> | null = null
// A plain object rather than a Map on purpose: the design kit's preview sandbox
// puts every lucide icon in scope by its bare name, and one of those icons is
// called `Map`, so `new Map()` is a TypeError in a preview and nowhere else.
// Nothing here needs Map's semantics, and a component that cannot be previewed
// is a component nobody can review.
const grammarLoads: Record<string, Promise<boolean>> = {}

function highlighter(): Promise<HighlighterCore> {
  core ??= createHighlighterCore({
    themes: [import('@shikijs/themes/github-light-default'), import('@shikijs/themes/dark-plus')],
    langs: [],
    engine,
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
    .then(() => true)
    .catch(() => false)
  grammarLoads[name] = load
  return load
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
export async function highlight(code: string, language: string): Promise<string | null> {
  try {
    const instance = await highlighter()
    if (!(await loadGrammar(instance, language))) {
      return null
    }
    return instance.codeToHtml(code, {
      lang: language,
      themes: { light: LIGHT_THEME, dark: DARK_THEME },
      defaultColor: false,
      // Marks the element as this component's own. Chat prose wraps long lines
      // in a `pre`, which is right for quoted output and wrong for code: a
      // wrapped line breaks the indentation the reader is using to follow it.
      // The mark is what the stylesheet hangs `white-space: pre` and horizontal
      // scrolling on, and what gives the block its box when it is rendered
      // outside chat prose entirely.
      transformers: [
        {
          pre(node) {
            node.properties['data-code-block'] = ''
          },
        },
      ],
    })
  } catch {
    return null
  }
}

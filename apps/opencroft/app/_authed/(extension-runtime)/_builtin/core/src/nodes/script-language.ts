// ═══════════════════════════════════════════════════════════════════
// The language a script node runs its code in
//
// A script node holds its language in `data.language`, which its type's
// `defaultData` sets. Data that lacks it, or names a language no script node
// runs, is the node's problem: the node still renders, as its type's
// language, and refuses to run until the field is set.
//
// Host-free, so the node, its inspector and the server read the same rules.
// ═══════════════════════════════════════════════════════════════════

import type { NodeDataProblem } from '@opencroft/core'

export const SCRIPT_LANGUAGES = ['bash', 'python', 'node'] as const

export type ScriptLanguage = (typeof SCRIPT_LANGUAGES)[number]

export function isScriptLanguage(value: unknown): value is ScriptLanguage {
  return typeof value === 'string' && (SCRIPT_LANGUAGES as readonly string[]).includes(value)
}

const LANGUAGE_LIST = SCRIPT_LANGUAGES.map((language) => `"${language}"`).join(', ')

/**
 * The script nodes' data validator (`nodeDataValidators`): a graph write that
 * gives a script node no language, or one it cannot run, is refused, and a
 * node already holding such data shows it as its error.
 */
export function scriptDataProblems(data: { language?: unknown } | undefined): NodeDataProblem[] {
  const language = data?.language
  if (isScriptLanguage(language)) {
    return []
  }
  return [
    {
      title: language === undefined ? 'No language set' : 'Language no script node runs',
      detail:
        language === undefined
          ? 'The node has no language, so running it is refused.'
          : `${JSON.stringify(language)} is not a language a script node runs, so running it is refused.`,
      next: `Set language to one of ${LANGUAGE_LIST}: the Details tab offers the node's own.`,
      path: 'language',
    },
  ]
}

import { type CompileError, compileErrorLocation } from '@/app/_authed/(extension-runtime)/_types'

/**
 * A use of something deprecated, found while building an extension: where it
 * is, what was used, and what replaces it. A deprecation never fails a build;
 * it is reported as a build warning — in the compile result, so in
 * `compile_extension` and on the Extensions page — and in the server log.
 */
export interface Deprecation {
  /** Relative to the extension's folder. */
  file: string
  line?: number
  column?: number
  /** What was used, as the author wrote it: `` `@ext/host` ``, `` `legacy` ``, a manifest key. */
  used: string
  /** What to use instead, in words an author can act on. */
  replacement: string
}

export function deprecationWarning(deprecation: Deprecation): CompileError {
  return {
    file: deprecation.file,
    line: deprecation.line,
    column: deprecation.column,
    message: `${deprecation.used} is deprecated: ${deprecation.replacement}`,
  }
}

/** One log entry per build that found any, listing each. */
export function logDeprecations(extensionId: string, deprecations: Deprecation[]): void {
  if (deprecations.length === 0) {
    return
  }
  const lines = deprecations.map((deprecation) => {
    const warning = deprecationWarning(deprecation)
    return `  ${compileErrorLocation(warning)}  ${warning.message}`
  })
  console.warn(`[ext] ${extensionId}: ${deprecations.length} deprecated use(s):\n${lines.join('\n')}`)
}

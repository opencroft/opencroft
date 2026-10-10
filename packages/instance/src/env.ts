// Every environment variable OpenCroft reads as configuration is named
// `OPENCROFT_*`. The ones below also answer to a deprecated unprefixed name,
// so a deployment that sets the deprecated name keeps working. Reading one
// through `readEnv` is what makes the deprecated name count:
// a reader that goes to `process.env` directly sees only the current name.
//
// Messages name variables, never values.

/** The variables that had another name, each mapped to the name it replaced. */
export const RENAMED_ENV = {
  OPENCROFT_AUTH_SECRET: 'BETTER_AUTH_SECRET',
  OPENCROFT_SECRETS_KEY: 'SECRETS_KEY',
  OPENCROFT_DATABASE_URL: 'DATABASE_URL',
  OPENCROFT_PGLITE_PATH: 'PGLITE_PATH',
  OPENCROFT_DB_MIGRATIONS_DIR: 'DB_MIGRATIONS_DIR',
  OPENCROFT_EXTENSION_REGISTRIES: 'EXTENSION_REGISTRIES',
  OPENCROFT_EXTENSIONS: 'EXTENSIONS',
  OPENCROFT_GOOGLE_CLIENT_ID: 'GOOGLE_CLIENT_ID',
  OPENCROFT_GOOGLE_CLIENT_SECRET: 'GOOGLE_CLIENT_SECRET',
  OPENCROFT_APPLE_CLIENT_ID: 'APPLE_CLIENT_ID',
  OPENCROFT_APPLE_CLIENT_SECRET: 'APPLE_CLIENT_SECRET',
  OPENCROFT_OPENCLAW_GATEWAY_URL: 'OPENCLAW_GATEWAY_URL',
  OPENCROFT_OPENCLAW_GATEWAY_TOKEN: 'OPENCLAW_GATEWAY_TOKEN',
} as const

export type RenamedEnvName = keyof typeof RENAMED_ENV

// Lines already logged in this process. Readers call `readEnv` on every use
// (each encrypt reads the secrets key), so without this one setting would
// repeat its line in the log for as long as the process runs.
const reported = new Set<string>()

/**
 * The variable's value, from its current name or else its former one. An empty
 * value counts as unset.
 *
 * The first time a process takes a value from the former name it logs that the
 * name is deprecated; the first time both names are set it logs that the
 * current one wins.
 */
export function readEnv(name: RenamedEnvName, env: NodeJS.ProcessEnv = process.env): string | undefined {
  const formerName = RENAMED_ENV[name]
  const current = env[name] || undefined
  const former = env[formerName] || undefined
  if (former !== undefined) {
    const line =
      current === undefined
        ? `[env] ${formerName} is deprecated and is used for now: rename it to ${name}.`
        : `[env] Both ${name} and ${formerName} are set: using ${name}. Remove ${formerName}.`
    if (!reported.has(line)) {
      reported.add(line)
      console.warn(line)
    }
  }
  return current ?? former
}

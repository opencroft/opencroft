// ═══════════════════════════════════════════════════════════════════
// A script node's environment
//
// What a script node's `env` field holds, and how its inspector, its Run
// action and an execution context's dispatch read it and write it back.
//
// STORED FORM. `env` is an object, variable name to value, in the order the
// variables were added. A value is typed text or `secret:<NAME>`, the name of
// a secret in a Secrets Store on the node's graph, resolved where the script
// runs. The node only ever holds the name, and the check before a secret is
// deleted finds it in node data by that prefix.
//
// LINE FORM. A node can also carry `env` as `KEY=VALUE` lines beside a
// `secrets` field, one secret name per line, each injected under its own
// name. `readEnvironment` reads that pair as the same list, so such a node
// shows and runs unchanged; the next write through `environmentPatch` stores
// the object and drops `secrets`.
//
// Host-free, so the node, its inspector and the server read the same rules.
// ═══════════════════════════════════════════════════════════════════

/** The host's prefix for a value that stands for a stored secret. */
export const SECRET_PREFIX = 'secret:'

/** Where a variable's value comes from: typed, or a stored secret named here. */
export type EnvironmentValue = { value: string } | { secret: string }

export type EnvironmentVariable = { name: string } & EnvironmentValue

/** What `env` holds: variable name to typed value or `secret:<NAME>`. */
export type EnvironmentMap = Record<string, string>

// Names that would reach an object's prototype instead of becoming a key of their own.
const RESERVED_NAMES = new Set(['__proto__', 'constructor', 'prototype'])

/**
 * What is wrong with a variable name, as a sentence, or undefined when it is
 * fine. A process takes any name up to an `=`; whitespace in one is a typing
 * slip rather than a name anybody means.
 */
export function envNameProblem(name: string): string | undefined {
  if (!name) {
    return 'A variable needs a name.'
  }
  if (/[\s=]/.test(name)) {
    return `"${name}" is not a variable name: it cannot hold whitespace or an equals sign.`
  }
  if (RESERVED_NAMES.has(name)) {
    return `"${name}" cannot be used as a variable name.`
  }
  return undefined
}

function fromStored(raw: string): EnvironmentValue {
  if (raw.startsWith(SECRET_PREFIX)) {
    return { secret: raw.slice(SECRET_PREFIX.length).trim() }
  }
  return { value: raw }
}

function lines(raw: unknown): string[] {
  if (typeof raw !== 'string') {
    return []
  }
  return raw
    .split('\n')
    .map((line) => line.trim())
    .filter(Boolean)
}

// The line form's pair of fields as one list. A name given twice keeps its
// first position and its last value, and a secret overrides a typed line of
// the same name: what the script was run with from them.
function fromLines(env: unknown, secretNames: unknown): EnvironmentVariable[] {
  const byName = new Map<string, EnvironmentValue>()
  for (const line of lines(env)) {
    const eq = line.indexOf('=')
    if (eq > 0) {
      byName.set(line.slice(0, eq).trim(), { value: line.slice(eq + 1) })
    }
  }
  for (const name of lines(secretNames)) {
    byName.set(name, { secret: name })
  }
  return [...byName].map(([name, value]) => ({ name, ...value }))
}

/** A node's variables, in order, from either stored form. */
export function readEnvironment(data: { env?: unknown; secrets?: unknown }): EnvironmentVariable[] {
  const { env } = data
  if (env === null || typeof env !== 'object' || Array.isArray(env)) {
    return fromLines(env, data.secrets)
  }
  return Object.entries(env)
    .filter((entry): entry is [string, string] => typeof entry[1] === 'string')
    .map(([name, raw]) => ({ name, ...fromStored(raw) }))
}

/**
 * The data patch that stores `variables`: `env` as the object, and the line
 * form's `secrets` field removed (undefined deletes a key from node data). An
 * empty name and a prototype key are left out; any other name is kept, even
 * one `envNameProblem` would refuse for a new variable, because a node in the
 * line form can hold one the script runs with, and storing it must not drop it.
 */
export function environmentPatch(variables: EnvironmentVariable[]): { env: EnvironmentMap; secrets: undefined } {
  const env: EnvironmentMap = {}
  for (const variable of variables) {
    if (!variable.name || RESERVED_NAMES.has(variable.name)) {
      continue
    }
    env[variable.name] = 'secret' in variable ? `${SECRET_PREFIX}${variable.secret}` : variable.value
  }
  return { env, secrets: undefined }
}

/**
 * The variables a script runs with: each typed value as it is, each secret
 * through `resolveSecret`, which is given the stored `secret:<NAME>` value
 * and throws for a name it cannot resolve.
 */
export async function resolveEnvironment(
  data: { env?: unknown; secrets?: unknown },
  resolveSecret: (stored: string) => Promise<string>,
): Promise<Record<string, string>> {
  const entries: [string, string][] = []
  for (const variable of readEnvironment(data)) {
    const value = 'secret' in variable ? await resolveSecret(`${SECRET_PREFIX}${variable.secret}`) : variable.value
    entries.push([variable.name, value])
  }
  // Defines each name as a key of its own, a prototype key included, rather than assigning it.
  return Object.fromEntries(entries)
}

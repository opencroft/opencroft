// The instance's own keys: the secret that signs sessions and the passphrase
// stored secrets are encrypted under.
//
// Each comes from its environment variable when that is set, and otherwise
// from one file in the data volume, written the first time a key is needed.
// So a container started with no configuration at all still gets keys of its
// own, and keeps them across restarts and recreates on the same volume.
//
// Nothing here prints, throws or returns a key's value except as the value
// itself: messages name the variable and the file, never what is in it.
//
// Each key also answers to a deprecated name (see RENAMED_ENV), both as a
// variable and as a key file entry. Entries are never renamed or removed, so
// a build that reads the deprecated names finds its keys on the same volume.

import { randomBytes } from 'node:crypto'
import { chmodSync, mkdirSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from 'node:fs'
import path from 'node:path'

import { dataDir } from './data-dir'
import { RENAMED_ENV, readEnv } from './env'

/** The instance keys, each named by the environment variable that overrides it. */
export const INSTANCE_KEY_NAMES = ['OPENCROFT_AUTH_SECRET', 'OPENCROFT_SECRETS_KEY'] as const

export type InstanceKeyName = (typeof INSTANCE_KEY_NAMES)[number]

/** Where a key's value comes from: its environment variable, or the key file. */
export type InstanceKeySource = 'env' | 'file'

export interface InstanceKey {
  value: string
  source: InstanceKeySource
}

// Every entry name the file may hold: each key under its name and its former one.
const KEY_FILE_ENTRIES: readonly string[] = INSTANCE_KEY_NAMES.flatMap((name) => [name, RENAMED_ENV[name]])

type KeyFileContents = Record<string, string>

// Owner read and write only: the file holds the keys themselves.
const FILE_MODE = 0o600

/** The key file's path. It sits in the data directory, so it lives on the data volume. */
export function instanceKeyFile(): string {
  return dataDir('instance-secrets.json')
}

/**
 * What an operator is told while any key comes from the file: once per start in
 * the log, and behind the line across the top of the setup page and of an
 * administrator's settings.
 */
export function keyFileNotice(file: string): string {
  return (
    `Instance keys are stored in ${file} in the data volume. ` +
    'Anyone with this volume or its backups can use them. ' +
    'For production, set OPENCROFT_AUTH_SECRET and OPENCROFT_SECRETS_KEY from your own secret store, then delete the file. ' +
    'Deleting it without setting them makes the next start generate new keys: ' +
    'everyone is signed out and stored secrets can no longer be read.'
  )
}

/** The key's value if one exists, from its environment variable or else the key file. Never creates one. */
export function readInstanceKey(name: InstanceKeyName): InstanceKey | null {
  const fromEnv = readEnv(name)
  if (fromEnv) {
    return { value: fromEnv, source: 'env' }
  }
  const contents = readKeyFile(instanceKeyFile())
  const fromFile = contents[name] ?? contents[RENAMED_ENV[name]]
  return fromFile ? { value: fromFile, source: 'file' } : null
}

/**
 * The key's value, created the first time neither its environment variable nor
 * the key file has one, and saved in the file so every later start reads the
 * same value back.
 *
 * `initialValue` decides what is saved; by default 32 random bytes. Only the
 * named key is added: the file's other entries are kept as they are.
 */
export function ensureInstanceKey(name: InstanceKeyName, initialValue: () => string = randomKey): InstanceKey {
  const existing = readInstanceKey(name)
  if (existing) {
    return existing
  }
  const file = instanceKeyFile()
  const value = initialValue()
  writeKeyFile(file, { ...readKeyFile(file), [name]: value })
  return { value, source: 'file' }
}

/** Where each key comes from now, or null for a key that does not exist yet. */
export function instanceKeySources(): Record<InstanceKeyName, InstanceKeySource | null> {
  const sources = {} as Record<InstanceKeyName, InstanceKeySource | null>
  for (const name of INSTANCE_KEY_NAMES) {
    sources[name] = readInstanceKey(name)?.source ?? null
  }
  return sources
}

function randomKey(): string {
  return randomBytes(32).toString('base64url')
}

function readKeyFile(file: string): KeyFileContents {
  let text: string
  try {
    text = readFileSync(file, 'utf8')
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') {
      return {}
    }
    throw err
  }
  tightenMode(file)
  // The parser's own message is not passed on: it quotes the text it failed
  // on, and that text is the keys.
  let parsed: unknown
  try {
    parsed = JSON.parse(text)
  } catch {
    throw unreadableKeyFile(file)
  }
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    throw unreadableKeyFile(file)
  }
  const contents: KeyFileContents = {}
  for (const entry of KEY_FILE_ENTRIES) {
    if (!Object.hasOwn(parsed, entry)) {
      continue
    }
    const value = (parsed as Record<string, unknown>)[entry]
    if (typeof value !== 'string' || value === '') {
      throw unreadableKeyFile(file)
    }
    contents[entry] = value
  }
  return contents
}

// A damaged file is never replaced: the keys in it are what the stored
// secrets and the sessions depend on, and new ones would quietly lose both.
function unreadableKeyFile(file: string): Error {
  return new Error(
    `The instance key file ${file} is not a JSON object of non-empty strings. ` +
      'It was left as it is, because replacing it would lose the keys stored secrets and sessions depend on. ' +
      'Restore it from a copy, set OPENCROFT_AUTH_SECRET and OPENCROFT_SECRETS_KEY instead, or move it away to start over with new keys.',
  )
}

// A file copied in by hand, or restored by a tool that does not keep modes,
// can arrive readable by everyone on the host.
function tightenMode(file: string): void {
  try {
    if ((statSync(file).mode & 0o077) !== 0) {
      chmodSync(file, FILE_MODE)
    }
  } catch {
    console.warn(`[instance-keys] could not restrict ${file} to its owner; check its permissions`)
  }
}

// Written beside the target and renamed over it, so a crash mid-write leaves
// the previous file whole rather than half a file.
function writeKeyFile(file: string, contents: KeyFileContents): void {
  mkdirSync(path.dirname(file), { recursive: true })
  const temp = `${file}.${process.pid}.${randomBytes(4).toString('hex')}.tmp`
  try {
    writeFileSync(temp, `${JSON.stringify(contents, null, 2)}\n`, { mode: FILE_MODE, flag: 'wx' })
    renameSync(temp, file)
  } finally {
    rmSync(temp, { force: true })
  }
}

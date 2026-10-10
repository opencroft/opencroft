/**
 * `@opencroft/server/system` — the machine the host runs on: its file system,
 * processes and the host's encryption.
 */
import type * as nodeFs from 'node:fs'
import type * as nodeOs from 'node:os'
import type * as nodePath from 'node:path'

export interface HostCryptoApi {
  /** Encrypt with the host's key, as the Secrets Store does. */
  encrypt(value: string): string
  decrypt(value: string): string
  randomToken(bytes?: number): string
  /** CSPRNG-uniform random string of `length` characters drawn from `charset`. */
  randomString(length: number, charset: string): string
}

export declare const fs: typeof nodeFs.promises
export declare const os: typeof nodeOs
export declare const path: typeof nodePath
/** Run a shell command on the host and resolve with its stdout. */
export declare const exec: (cmd: string) => Promise<string>
/** Run a program on the host without a shell and resolve with its stdout. */
export declare const execFile: (cmd: string, args: string[]) => Promise<string>
export declare const crypto: HostCryptoApi

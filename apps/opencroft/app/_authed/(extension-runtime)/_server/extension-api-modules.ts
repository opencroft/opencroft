import type { ExtensionClientModules } from '@/app/_authed/(extension-runtime)/_client/host'
import type { ExtensionHost } from './host'

/** A module of `@opencroft/client`: a key of the browser's `__extHost.modules`. */
export type ClientModule = keyof ExtensionClientModules

/**
 * The host member each `@opencroft/server/<module>` exports, by module. The
 * server host is built per extension (`createHost`), so its modules are named
 * here rather than read off one object; host-api-declarations.test.ts holds this
 * against both the host and `packages/server`.
 *
 * `actions`, `routes`, `tools` and `lifecycle` declare contracts an extension
 * implements and export no host member.
 */
export const SERVER_MODULES = {
  actions: [],
  apps: ['apps'],
  chat: ['groupChats', 'sendMessage'],
  collab: ['collab'],
  events: ['events'],
  extension: ['extensionId', 'urlBase', 'assetUrl', 'routeUrl', 'absoluteUrl'],
  graph: ['graph'],
  lifecycle: [],
  people: ['users', 'agents', 'mentions', 'mcpTokens'],
  routes: [],
  secrets: ['secrets'],
  settings: ['settings'],
  storage: ['storage', 'cacheDir', 'dataDir'],
  system: ['fs', 'os', 'path', 'exec', 'execFile', 'crypto'],
  terminal: ['terminal', 'ssh', 'execContext'],
  tools: [],
} as const satisfies Record<string, readonly (keyof ExtensionHost)[]>

export type ServerModule = keyof typeof SERVER_MODULES

export function isServerModule(name: string): name is ServerModule {
  return Object.hasOwn(SERVER_MODULES, name)
}

/** Every host member a server module exports, across all of them. */
export function serverModuleNames(): string[] {
  return Object.values(SERVER_MODULES).flat()
}

/**
 * Deprecated names with no module of their own, and what replaces each. Every
 * other deprecated name is exported, unchanged, from a module.
 */
export const RETIRED_CLIENT_NAMES: Record<string, string> = {
  React: "`import React from 'react'` (or the hooks by name)",
  createPortal: "`import { createPortal } from 'react-dom'`",
  icons: 'each icon by name from `lucide-react`',
  toast: "`import { toast } from 'sonner'`",
  InspectorTerminalBody: '`Terminal` from `@opencroft/client/terminal`',
}

/**
 * The whole server host as one object: what `@opencroft/server`'s default
 * export is, and what every module's named exports are members of.
 */
import type { HostAppsApi } from './apps'
import type { HostGroupChatsApi, HostSendMessageApi } from './chat'
import type { HostCollabApi } from './collab'
import type { HostEventsApi } from './events'
import type { HostGraphApi } from './graph'
import type { HostAgentsApi, HostMcpTokensApi, HostMentionsApi, HostUsersApi } from './people'
import type { HostSecretsApi } from './secrets'
import type { HostSettingsApi } from './settings'
import type { ExtensionStorageApi } from './storage'
import type { HostCryptoApi } from './system'
import type { HostExecContextApi, HostSshApi, HostTerminalApi } from './terminal'

export interface ExtensionServerHost {
  extensionId: string
  urlBase: string
  assetUrl(path: string): string
  routeUrl(path: string): string
  absoluteUrl(request: Request, url?: string): string
  fs: typeof import('node:fs').promises
  os: typeof import('node:os')
  path: typeof import('node:path')
  exec(cmd: string): Promise<string>
  execFile(cmd: string, args: string[]): Promise<string>
  crypto: HostCryptoApi
  cacheDir(...parts: string[]): string
  dataDir(...parts: string[]): string
  storage: ExtensionStorageApi
  settings: HostSettingsApi
  secrets: HostSecretsApi
  graph: HostGraphApi
  apps: HostAppsApi
  sendMessage: HostSendMessageApi
  groupChats: HostGroupChatsApi
  users: HostUsersApi
  agents: HostAgentsApi
  mentions: HostMentionsApi
  mcpTokens: HostMcpTokensApi
  events: HostEventsApi
  collab: HostCollabApi
  terminal: HostTerminalApi
  ssh: HostSshApi
  execContext: HostExecContextApi
}

/** The whole host. Each member is also a named export of its module: `graph` of `@opencroft/server/graph`, and so on. */
declare const host: ExtensionServerHost
export default host

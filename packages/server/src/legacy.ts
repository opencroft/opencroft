// GENERATED from the extension API modules and the host's runtime surface by
// apps/opencroft/app/_authed/(extension-runtime)/_server/legacy-declarations.ts.
// Do not edit: run `npm run generate:legacy-declarations -w apps/opencroft`.
/**
 * `legacy` — the server host's whole surface under one namespace,
 * deprecated. Every name here is its module's own, re-exported; import it from
 * that module instead.
 */
export type {
  /** @deprecated Import `ActionAccess` from `@opencroft/server/actions`. */
  ActionAccess,
  /** @deprecated Import `ActionAccessMap` from `@opencroft/server/actions`. */
  ActionAccessMap,
  /** @deprecated Import `ConnectedSource` from `@opencroft/server/actions`. */
  ConnectedSource,
  /** @deprecated Import `ExposeOutput` from `@opencroft/server/actions`. */
  ExposeOutput,
  /** @deprecated Import `ExtensionAction` from `@opencroft/server/actions`. */
  ExtensionAction,
  /** @deprecated Import `ExtensionActions` from `@opencroft/server/actions`. */
  ExtensionActions,
  /** @deprecated Import `NodeActionAccessMap` from `@opencroft/server/actions`. */
  NodeActionAccessMap,
  /** @deprecated Import `NodeActionContext` from `@opencroft/server/actions`. */
  NodeActionContext,
  /** @deprecated Import `NodeActionContextNode` from `@opencroft/server/actions`. */
  NodeActionContextNode,
  /** @deprecated Import `NodeActionHandler` from `@opencroft/server/actions`. */
  NodeActionHandler,
  /** @deprecated Import `NodeActions` from `@opencroft/server/actions`. */
  NodeActions,
  /** @deprecated Import `ResolvedInput` from `@opencroft/server/actions`. */
  ResolvedInput,
  /** @deprecated Import `Stream` from `@opencroft/server/actions`. */
  Stream,
} from './actions'
export {
  /** @deprecated Import `AppActionContext` from `@opencroft/server/apps`. */
  type AppActionContext,
  /** @deprecated Import `AppActionHandler` from `@opencroft/server/apps`. */
  type AppActionHandler,
  /** @deprecated Import `AppInstanceContext` from `@opencroft/server/apps`. */
  type AppInstanceContext,
  /** @deprecated Import `AppServerHooks` from `@opencroft/server/apps`. */
  type AppServerHooks,
  /** @deprecated Import `AppsExport` from `@opencroft/server/apps`. */
  type AppsExport,
  /** @deprecated Import `apps` from `@opencroft/server/apps`. */
  apps,
  /** @deprecated Import `HostAppInstance` from `@opencroft/server/apps`. */
  type HostAppInstance,
  /** @deprecated Import `HostAppsApi` from `@opencroft/server/apps`. */
  type HostAppsApi,
} from './apps'
export {
  /** @deprecated Import `groupChats` from `@opencroft/server/chat`. */
  groupChats,
  /** @deprecated Import `HostAgentGroupChatsApi` from `@opencroft/server/chat`. */
  type HostAgentGroupChatsApi,
  /** @deprecated Import `HostCompactResult` from `@opencroft/server/chat`. */
  type HostCompactResult,
  /** @deprecated Import `HostGroupChat` from `@opencroft/server/chat`. */
  type HostGroupChat,
  /** @deprecated Import `HostGroupChatsApi` from `@opencroft/server/chat`. */
  type HostGroupChatsApi,
  /** @deprecated Import `HostGroupChatThread` from `@opencroft/server/chat`. */
  type HostGroupChatThread,
  /** @deprecated Import `HostPersonGroupChat` from `@opencroft/server/chat`. */
  type HostPersonGroupChat,
  /** @deprecated Import `HostPersonGroupChatsApi` from `@opencroft/server/chat`. */
  type HostPersonGroupChatsApi,
  /** @deprecated Import `HostPresence` from `@opencroft/server/chat`. */
  type HostPresence,
  /** @deprecated Import `HostSendMessageApi` from `@opencroft/server/chat`. */
  type HostSendMessageApi,
  /** @deprecated Import `HostSendMessageResult` from `@opencroft/server/chat`. */
  type HostSendMessageResult,
  /** @deprecated Import `HostSessionOptions` from `@opencroft/server/chat`. */
  type HostSessionOptions,
  /** @deprecated Import `HostSessionOptionsResult` from `@opencroft/server/chat`. */
  type HostSessionOptionsResult,
  /** @deprecated Import `HostThreadContext` from `@opencroft/server/chat`. */
  type HostThreadContext,
  /** @deprecated Import `HostThreadTurn` from `@opencroft/server/chat`. */
  type HostThreadTurn,
  /** @deprecated Import `HostThreadTurnsPage` from `@opencroft/server/chat`. */
  type HostThreadTurnsPage,
  /** @deprecated Import `HostThreadUsage` from `@opencroft/server/chat`. */
  type HostThreadUsage,
  /** @deprecated Import `HostThreadUsageTurn` from `@opencroft/server/chat`. */
  type HostThreadUsageTurn,
  /** @deprecated Import `sendMessage` from `@opencroft/server/chat`. */
  sendMessage,
} from './chat'
export {
  /** @deprecated Import `collab` from `@opencroft/server/collab`. */
  collab,
  /** @deprecated Import `HostCollabApi` from `@opencroft/server/collab`. */
  type HostCollabApi,
  /** @deprecated Import `HostMarkdownDocStorage` from `@opencroft/server/collab`. */
  type HostMarkdownDocStorage,
  /** @deprecated Import `HostMarkdownEditOrigin` from `@opencroft/server/collab`. */
  type HostMarkdownEditOrigin,
} from './collab'
export {
  /** @deprecated Import `events` from `@opencroft/server/events`. */
  events,
  /** @deprecated Import `HostEventsApi` from `@opencroft/server/events`. */
  type HostEventsApi,
} from './events'
export {
  /** @deprecated Import `absoluteUrl` from `@opencroft/server/extension`. */
  absoluteUrl,
  /** @deprecated Import `assetUrl` from `@opencroft/server/extension`. */
  assetUrl,
  /** @deprecated Import `extensionId` from `@opencroft/server/extension`. */
  extensionId,
  /** @deprecated Import `routeUrl` from `@opencroft/server/extension`. */
  routeUrl,
  /** @deprecated Import `urlBase` from `@opencroft/server/extension`. */
  urlBase,
} from './extension'
export {
  /** @deprecated Import `GraphEdgeRecord` from `@opencroft/server/graph`. */
  type GraphEdgeRecord,
  /** @deprecated Import `GraphNodeRecord` from `@opencroft/server/graph`. */
  type GraphNodeRecord,
  /** @deprecated Import `graph` from `@opencroft/server/graph`. */
  graph,
  /** @deprecated Import `HandleInfo` from `@opencroft/server/graph`. */
  type HandleInfo,
  /** @deprecated Import `HostGraphApi` from `@opencroft/server/graph`. */
  type HostGraphApi,
  /** @deprecated Import `ListHandlesFilter` from `@opencroft/server/graph`. */
  type ListHandlesFilter,
} from './graph'
export type {
  /** @deprecated Import `ExtensionContext` from `@opencroft/server/lifecycle`. */
  ExtensionContext,
  /** @deprecated Import `Load` from `@opencroft/server/lifecycle`. */
  Load,
  /** @deprecated Import `Unload` from `@opencroft/server/lifecycle`. */
  Unload,
} from './lifecycle'
export {
  /** @deprecated Import `agents` from `@opencroft/server/people`. */
  agents,
  /** @deprecated Import `HostAgent` from `@opencroft/server/people`. */
  type HostAgent,
  /** @deprecated Import `HostAgentsApi` from `@opencroft/server/people`. */
  type HostAgentsApi,
  /** @deprecated Import `HostMcpTokenInfo` from `@opencroft/server/people`. */
  type HostMcpTokenInfo,
  /** @deprecated Import `HostMcpTokensApi` from `@opencroft/server/people`. */
  type HostMcpTokensApi,
  /** @deprecated Import `HostMention` from `@opencroft/server/people`. */
  type HostMention,
  /** @deprecated Import `HostMentionsApi` from `@opencroft/server/people`. */
  type HostMentionsApi,
  /** @deprecated Import `HostUser` from `@opencroft/server/people`. */
  type HostUser,
  /** @deprecated Import `HostUsersApi` from `@opencroft/server/people`. */
  type HostUsersApi,
  /** @deprecated Import `mcpTokens` from `@opencroft/server/people`. */
  mcpTokens,
  /** @deprecated Import `mentions` from `@opencroft/server/people`. */
  mentions,
  /** @deprecated Import `users` from `@opencroft/server/people`. */
  users,
} from './people'
export type {
  /** @deprecated Import `ExtensionRoute` from `@opencroft/server/routes`. */
  ExtensionRoute,
  /** @deprecated Import `ExtensionRouteContext` from `@opencroft/server/routes`. */
  ExtensionRouteContext,
  /** @deprecated Import `ExtensionRouteHandler` from `@opencroft/server/routes`. */
  ExtensionRouteHandler,
  /** @deprecated Import `ExtensionRoutes` from `@opencroft/server/routes`. */
  ExtensionRoutes,
  /** @deprecated Import `ExtensionSessionRoute` from `@opencroft/server/routes`. */
  ExtensionSessionRoute,
} from './routes'
export {
  /** @deprecated Import `HostSecretsApi` from `@opencroft/server/secrets`. */
  type HostSecretsApi,
  /** @deprecated Import `SecretRecord` from `@opencroft/server/secrets`. */
  type SecretRecord,
  /** @deprecated Import `secrets` from `@opencroft/server/secrets`. */
  secrets,
} from './secrets'
export {
  /** @deprecated Import `HostSetting` from `@opencroft/server/settings`. */
  type HostSetting,
  /** @deprecated Import `HostSettingsApi` from `@opencroft/server/settings`. */
  type HostSettingsApi,
  /** @deprecated Import `settings` from `@opencroft/server/settings`. */
  settings,
} from './settings'
export {
  /** @deprecated Import `cacheDir` from `@opencroft/server/storage`. */
  cacheDir,
  /** @deprecated Import `dataDir` from `@opencroft/server/storage`. */
  dataDir,
  /** @deprecated Import `ExtensionStorageApi` from `@opencroft/server/storage`. */
  type ExtensionStorageApi,
  /** @deprecated Import `storage` from `@opencroft/server/storage`. */
  storage,
} from './storage'
export {
  /** @deprecated Import `crypto` from `@opencroft/server/system`. */
  crypto,
  /** @deprecated Import `exec` from `@opencroft/server/system`. */
  exec,
  /** @deprecated Import `execFile` from `@opencroft/server/system`. */
  execFile,
  /** @deprecated Import `fs` from `@opencroft/server/system`. */
  fs,
  /** @deprecated Import `HostCryptoApi` from `@opencroft/server/system`. */
  type HostCryptoApi,
  /** @deprecated Import `os` from `@opencroft/server/system`. */
  os,
  /** @deprecated Import `path` from `@opencroft/server/system`. */
  path,
} from './system'
export {
  /** @deprecated Import `ExecOptions` from `@opencroft/server/terminal`. */
  type ExecOptions,
  /** @deprecated Import `ExecResult` from `@opencroft/server/terminal`. */
  type ExecResult,
  /** @deprecated Import `execContext` from `@opencroft/server/terminal`. */
  execContext,
  /** @deprecated Import `HostExecContextApi` from `@opencroft/server/terminal`. */
  type HostExecContextApi,
  /** @deprecated Import `HostSshApi` from `@opencroft/server/terminal`. */
  type HostSshApi,
  /** @deprecated Import `HostTerminalApi` from `@opencroft/server/terminal`. */
  type HostTerminalApi,
  /** @deprecated Import `JobSession` from `@opencroft/server/terminal`. */
  type JobSession,
  /** @deprecated Import `JobSessionOptions` from `@opencroft/server/terminal`. */
  type JobSessionOptions,
  /** @deprecated Import `ServerConfig` from `@opencroft/server/terminal`. */
  type ServerConfig,
  /** @deprecated Import `ssh` from `@opencroft/server/terminal`. */
  ssh,
  /** @deprecated Import `TerminalContext` from `@opencroft/server/terminal`. */
  type TerminalContext,
  /** @deprecated Import `terminal` from `@opencroft/server/terminal`. */
  terminal,
} from './terminal'
export type {
  /** @deprecated Import `ExtensionToolHandler` from `@opencroft/server/tools`. */
  ExtensionToolHandler,
  /** @deprecated Import `McpToolMeta` from `@opencroft/server/tools`. */
  McpToolMeta,
} from './tools'

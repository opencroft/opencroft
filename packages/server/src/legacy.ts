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
  /** @deprecated Import `agentInstructions` from `@opencroft/server/agents`. */
  agentInstructions,
  /** @deprecated Import `HostAgentInstructionFile` from `@opencroft/server/agents`. */
  type HostAgentInstructionFile,
  /** @deprecated Import `HostAgentInstructionRole` from `@opencroft/server/agents`. */
  type HostAgentInstructionRole,
  /** @deprecated Import `HostAgentInstructions` from `@opencroft/server/agents`. */
  type HostAgentInstructions,
  /** @deprecated Import `HostAgentInstructionsApi` from `@opencroft/server/agents`. */
  type HostAgentInstructionsApi,
  /** @deprecated Import `HostAgentInstructionsWrite` from `@opencroft/server/agents`. */
  type HostAgentInstructionsWrite,
} from './agents'
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
  /** @deprecated Import `HostAppDirectoryEntry` from `@opencroft/server/apps`. */
  type HostAppDirectoryEntry,
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
  /** @deprecated Import `HostThreadActivityPage` from `@opencroft/server/chat`. */
  type HostThreadActivityPage,
  /** @deprecated Import `HostThreadContext` from `@opencroft/server/chat`. */
  type HostThreadContext,
  /** @deprecated Import `HostThreadStatus` from `@opencroft/server/chat`. */
  type HostThreadStatus,
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
  /** @deprecated Import `DynamicHandleLister` from `@opencroft/server/graph`. */
  type DynamicHandleLister,
  /** @deprecated Import `DynamicHandles` from `@opencroft/server/graph`. */
  type DynamicHandles,
  /** @deprecated Import `GraphEdgeRecord` from `@opencroft/server/graph`. */
  type GraphEdgeRecord,
  /** @deprecated Import `GraphNodePatch` from `@opencroft/server/graph`. */
  type GraphNodePatch,
  /** @deprecated Import `GraphNodeRecord` from `@opencroft/server/graph`. */
  type GraphNodeRecord,
  /** @deprecated Import `graph` from `@opencroft/server/graph`. */
  graph,
  /** @deprecated Import `HandleInfo` from `@opencroft/server/graph`. */
  type HandleInfo,
  /** @deprecated Import `HandleTypeRecord` from `@opencroft/server/graph`. */
  type HandleTypeRecord,
  /** @deprecated Import `HostGraphApi` from `@opencroft/server/graph`. */
  type HostGraphApi,
  /** @deprecated Import `ListHandlesFilter` from `@opencroft/server/graph`. */
  type ListHandlesFilter,
  /** @deprecated Import `NodeCheck` from `@opencroft/server/graph`. */
  type NodeCheck,
  /** @deprecated Import `NodeCheckEdge` from `@opencroft/server/graph`. */
  type NodeCheckEdge,
  /** @deprecated Import `NodeCheckInstance` from `@opencroft/server/graph`. */
  type NodeCheckInstance,
  /** @deprecated Import `NodeCheckRecord` from `@opencroft/server/graph`. */
  type NodeCheckRecord,
  /** @deprecated Import `NodeChecks` from `@opencroft/server/graph`. */
  type NodeChecks,
  /** @deprecated Import `NodeDataValidator` from `@opencroft/server/graph`. */
  type NodeDataValidator,
  /** @deprecated Import `NodeDataValidators` from `@opencroft/server/graph`. */
  type NodeDataValidators,
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
  /** @deprecated Import `HostAgentPresence` from `@opencroft/server/people`. */
  type HostAgentPresence,
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
  /** @deprecated Import `CredentialRedactor` from `@opencroft/server/secrets`. */
  type CredentialRedactor,
  /** @deprecated Import `CredentialRedactorOptions` from `@opencroft/server/secrets`. */
  type CredentialRedactorOptions,
  /** @deprecated Import `credentialRedactor` from `@opencroft/server/secrets`. */
  credentialRedactor,
  /** @deprecated Import `HostSecretsApi` from `@opencroft/server/secrets`. */
  type HostSecretsApi,
  /** @deprecated Import `NodeCredentialProperties` from `@opencroft/server/secrets`. */
  type NodeCredentialProperties,
  /** @deprecated Import `RandomSecretSpec` from `@opencroft/server/secrets`. */
  type RandomSecretSpec,
  /** @deprecated Import `SecretFormat` from `@opencroft/server/secrets`. */
  type SecretFormat,
  /** @deprecated Import `SecretKeyRecord` from `@opencroft/server/secrets`. */
  type SecretKeyRecord,
  /** @deprecated Import `SecretRecipe` from `@opencroft/server/secrets`. */
  type SecretRecipe,
  /** @deprecated Import `SecretRecord` from `@opencroft/server/secrets`. */
  type SecretRecord,
  /** @deprecated Import `SecretReference` from `@opencroft/server/secrets`. */
  type SecretReference,
  /** @deprecated Import `SecretScope` from `@opencroft/server/secrets`. */
  type SecretScope,
  /** @deprecated Import `StreamRedactor` from `@opencroft/server/secrets`. */
  type StreamRedactor,
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
  /** @deprecated Import `HostDirectoryChange` from `@opencroft/server/spaces`. */
  type HostDirectoryChange,
  /** @deprecated Import `HostSpace` from `@opencroft/server/spaces`. */
  type HostSpace,
  /** @deprecated Import `HostSpacesApi` from `@opencroft/server/spaces`. */
  type HostSpacesApi,
  /** @deprecated Import `spaces` from `@opencroft/server/spaces`. */
  spaces,
} from './spaces'
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
  /** @deprecated Import `instanceId` from `@opencroft/server/system`. */
  instanceId,
  /** @deprecated Import `os` from `@opencroft/server/system`. */
  os,
  /** @deprecated Import `path` from `@opencroft/server/system`. */
  path,
} from './system'
export {
  /** @deprecated Import `agentRefusalOf` from `@opencroft/server/terminal`. */
  agentRefusalOf,
  /** @deprecated Import `ExecDispatchOptions` from `@opencroft/server/terminal`. */
  type ExecDispatchOptions,
  /** @deprecated Import `ExecOptions` from `@opencroft/server/terminal`. */
  type ExecOptions,
  /** @deprecated Import `ExecResult` from `@opencroft/server/terminal`. */
  type ExecResult,
  /** @deprecated Import `execContext` from `@opencroft/server/terminal`. */
  execContext,
  /** @deprecated Import `GraphCallAction` from `@opencroft/server/terminal`. */
  type GraphCallAction,
  /** @deprecated Import `GraphCallTarget` from `@opencroft/server/terminal`. */
  type GraphCallTarget,
  /** @deprecated Import `GraphCallTargets` from `@opencroft/server/terminal`. */
  type GraphCallTargets,
  /** @deprecated Import `HostExecContextApi` from `@opencroft/server/terminal`. */
  type HostExecContextApi,
  /** @deprecated Import `HostSshApi` from `@opencroft/server/terminal`. */
  type HostSshApi,
  /** @deprecated Import `HostSshKeysApi` from `@opencroft/server/terminal`. */
  type HostSshKeysApi,
  /** @deprecated Import `HostTerminalApi` from `@opencroft/server/terminal`. */
  type HostTerminalApi,
  /** @deprecated Import `JobSession` from `@opencroft/server/terminal`. */
  type JobSession,
  /** @deprecated Import `JobSessionOptions` from `@opencroft/server/terminal`. */
  type JobSessionOptions,
  /** @deprecated Import `ServerConfig` from `@opencroft/server/terminal`. */
  type ServerConfig,
  /** @deprecated Import `SpawnedProcess` from `@opencroft/server/terminal`. */
  type SpawnedProcess,
  /** @deprecated Import `SpawnOptions` from `@opencroft/server/terminal`. */
  type SpawnOptions,
  /** @deprecated Import `SshKeyRecord` from `@opencroft/server/terminal`. */
  type SshKeyRecord,
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
export {
  /** @deprecated Import `HostUsageApi` from `@opencroft/server/usage`. */
  type HostUsageApi,
  /** @deprecated Import `HostUsageGroupBy` from `@opencroft/server/usage`. */
  type HostUsageGroupBy,
  /** @deprecated Import `HostUsageScope` from `@opencroft/server/usage`. */
  type HostUsageScope,
  /** @deprecated Import `HostUsageSummaryOptions` from `@opencroft/server/usage`. */
  type HostUsageSummaryOptions,
  /** @deprecated Import `HostUsageSummaryRow` from `@opencroft/server/usage`. */
  type HostUsageSummaryRow,
  /** @deprecated Import `usage` from `@opencroft/server/usage`. */
  usage,
} from './usage'
export {
  /** @deprecated Import `AcceptedTypes` from `@opencroft/server/values`. */
  type AcceptedTypes,
  /** @deprecated Import `AWAITING_RUN_KEY` from `@opencroft/server/values`. */
  AWAITING_RUN_KEY,
  /** @deprecated Import `acceptedTypesPhrase` from `@opencroft/server/values`. */
  acceptedTypesPhrase,
  /** @deprecated Import `awaitingRunOf` from `@opencroft/server/values`. */
  awaitingRunOf,
  /** @deprecated Import `BOOLEAN_TYPE` from `@opencroft/server/values`. */
  BOOLEAN_TYPE,
  /** @deprecated Import `CompiledPattern` from `@opencroft/server/values`. */
  type CompiledPattern,
  /** @deprecated Import `compilePattern` from `@opencroft/server/values`. */
  compilePattern,
  /** @deprecated Import `DEFAULT_FILE_COLLISION` from `@opencroft/server/values`. */
  DEFAULT_FILE_COLLISION,
  /** @deprecated Import `EnumCasesField` from `@opencroft/server/values`. */
  type EnumCasesField,
  /** @deprecated Import `EnumCasesOf` from `@opencroft/server/values`. */
  type EnumCasesOf,
  /** @deprecated Import `EvaluateExpressionResult` from `@opencroft/server/values`. */
  type EvaluateExpressionResult,
  /** @deprecated Import `ExpressionError` from `@opencroft/server/values`. */
  type ExpressionError,
  /** @deprecated Import `ExpressionNode` from `@opencroft/server/values`. */
  type ExpressionNode,
  /** @deprecated Import `ExpressionType` from `@opencroft/server/values`. */
  type ExpressionType,
  /** @deprecated Import `ExpressionTypes` from `@opencroft/server/values`. */
  type ExpressionTypes,
  /** @deprecated Import `evaluateExpression` from `@opencroft/server/values`. */
  evaluateExpression,
  /** @deprecated Import `expressionTypes` from `@opencroft/server/values`. */
  expressionTypes,
  /** @deprecated Import `FILE_COLLISIONS` from `@opencroft/server/values`. */
  FILE_COLLISIONS,
  /** @deprecated Import `FILE_NAME_DEFAULT_FORMATS` from `@opencroft/server/values`. */
  FILE_NAME_DEFAULT_FORMATS,
  /** @deprecated Import `FILE_NAME_TOKENS` from `@opencroft/server/values`. */
  FILE_NAME_TOKENS,
  /** @deprecated Import `FileCollision` from `@opencroft/server/values`. */
  type FileCollision,
  /** @deprecated Import `FileNameToken` from `@opencroft/server/values`. */
  type FileNameToken,
  /** @deprecated Import `FileSaveSettings` from `@opencroft/server/values`. */
  type FileSaveSettings,
  /** @deprecated Import `FormatTemplateResult` from `@opencroft/server/values`. */
  type FormatTemplateResult,
  /** @deprecated Import `fileCollision` from `@opencroft/server/values`. */
  fileCollision,
  /** @deprecated Import `fileSaveSettings` from `@opencroft/server/values`. */
  fileSaveSettings,
  /** @deprecated Import `formatFileName` from `@opencroft/server/values`. */
  formatFileName,
  /** @deprecated Import `formatFilePath` from `@opencroft/server/values`. */
  formatFilePath,
  /** @deprecated Import `formatFolder` from `@opencroft/server/values`. */
  formatFolder,
  /** @deprecated Import `formatTemplate` from `@opencroft/server/values`. */
  formatTemplate,
  /** @deprecated Import `GroupType` from `@opencroft/server/values`. */
  type GroupType,
  /** @deprecated Import `handleTakes` from `@opencroft/server/values`. */
  handleTakes,
  /** @deprecated Import `handleTypesConnect` from `@opencroft/server/values`. */
  handleTypesConnect,
  /** @deprecated Import `INPUT_TYPES_KEY` from `@opencroft/server/values`. */
  INPUT_TYPES_KEY,
  /** @deprecated Import `InlineValueFields` from `@opencroft/server/values`. */
  type InlineValueFields,
  /** @deprecated Import `inputTypeOf` from `@opencroft/server/values`. */
  inputTypeOf,
  /** @deprecated Import `inputTypesOf` from `@opencroft/server/values`. */
  inputTypesOf,
  /** @deprecated Import `inputValue` from `@opencroft/server/values`. */
  inputValue,
  /** @deprecated Import `isEnumHandle` from `@opencroft/server/values`. */
  isEnumHandle,
  /** @deprecated Import `isObjectValue` from `@opencroft/server/values`. */
  isObjectValue,
  /** @deprecated Import `isPrimitiveType` from `@opencroft/server/values`. */
  isPrimitiveType,
  /** @deprecated Import `isPrimitiveValue` from `@opencroft/server/values`. */
  isPrimitiveValue,
  /** @deprecated Import `isValueHandle` from `@opencroft/server/values`. */
  isValueHandle,
  /** @deprecated Import `isValueType` from `@opencroft/server/values`. */
  isValueType,
  /** @deprecated Import `joinFilePath` from `@opencroft/server/values`. */
  joinFilePath,
  /** @deprecated Import `literalTemplate` from `@opencroft/server/values`. */
  literalTemplate,
  /** @deprecated Import `MAX_EXPRESSION_LENGTH` from `@opencroft/server/values`. */
  MAX_EXPRESSION_LENGTH,
  /** @deprecated Import `MAX_PATTERN_GROUPS` from `@opencroft/server/values`. */
  MAX_PATTERN_GROUPS,
  /** @deprecated Import `MAX_PATTERN_LENGTH` from `@opencroft/server/values`. */
  MAX_PATTERN_LENGTH,
  /** @deprecated Import `NO_ENUMS` from `@opencroft/server/values`. */
  NO_ENUMS,
  /** @deprecated Import `NUMBER_TYPE` from `@opencroft/server/values`. */
  NUMBER_TYPE,
  /** @deprecated Import `nextSaveCount` from `@opencroft/server/values`. */
  nextSaveCount,
  /** @deprecated Import `nodeName` from `@opencroft/server/values`. */
  nodeName,
  /** @deprecated Import `OBJECT_TYPE` from `@opencroft/server/values`. */
  OBJECT_TYPE,
  /** @deprecated Import `ObjectValue` from `@opencroft/server/values`. */
  type ObjectValue,
  /** @deprecated Import `ParsedExpression` from `@opencroft/server/values`. */
  type ParsedExpression,
  /** @deprecated Import `ParsedTemplate` from `@opencroft/server/values`. */
  type ParsedTemplate,
  /** @deprecated Import `ParseExpressionResult` from `@opencroft/server/values`. */
  type ParseExpressionResult,
  /** @deprecated Import `ParsePathResult` from `@opencroft/server/values`. */
  type ParsePathResult,
  /** @deprecated Import `Pattern` from `@opencroft/server/values`. */
  type Pattern,
  /** @deprecated Import `PatternGroup` from `@opencroft/server/values`. */
  type PatternGroup,
  /** @deprecated Import `PatternMatch` from `@opencroft/server/values`. */
  type PatternMatch,
  /** @deprecated Import `PRIMITIVE_TYPES` from `@opencroft/server/values`. */
  PRIMITIVE_TYPES,
  /** @deprecated Import `PrimitiveValue` from `@opencroft/server/values`. */
  type PrimitiveValue,
  /** @deprecated Import `parseExpression` from `@opencroft/server/values`. */
  parseExpression,
  /** @deprecated Import `parsePath` from `@opencroft/server/values`. */
  parsePath,
  /** @deprecated Import `parseTemplate` from `@opencroft/server/values`. */
  parseTemplate,
  /** @deprecated Import `RESOLVED_CONTEXTS_KEY` from `@opencroft/server/values`. */
  RESOLVED_CONTEXTS_KEY,
  /** @deprecated Import `ReadPathResult` from `@opencroft/server/values`. */
  type ReadPathResult,
  /** @deprecated Import `ReplaceResult` from `@opencroft/server/values`. */
  type ReplaceResult,
  /** @deprecated Import `ResolvedInputEntry` from `@opencroft/server/values`. */
  type ResolvedInputEntry,
  /** @deprecated Import `readPath` from `@opencroft/server/values`. */
  readPath,
  /** @deprecated Import `readValue` from `@opencroft/server/values`. */
  readValue,
  /** @deprecated Import `resolvedInputsOf` from `@opencroft/server/values`. */
  resolvedInputsOf,
  /** @deprecated Import `STRING_TYPE` from `@opencroft/server/values`. */
  STRING_TYPE,
  /** @deprecated Import `SWITCH_CONDITION_TYPES` from `@opencroft/server/values`. */
  SWITCH_CONDITION_TYPES,
  /** @deprecated Import `SwitchCase` from `@opencroft/server/values`. */
  type SwitchCase,
  /** @deprecated Import `SwitchOutputResult` from `@opencroft/server/values`. */
  type SwitchOutputResult,
  /** @deprecated Import `SwitchSettings` from `@opencroft/server/values`. */
  type SwitchSettings,
  /** @deprecated Import `switchCaseOutput` from `@opencroft/server/values`. */
  switchCaseOutput,
  /** @deprecated Import `switchCasesOf` from `@opencroft/server/values`. */
  switchCasesOf,
  /** @deprecated Import `switchConditionType` from `@opencroft/server/values`. */
  switchConditionType,
  /** @deprecated Import `switchOutput` from `@opencroft/server/values`. */
  switchOutput,
  /** @deprecated Import `TemplateError` from `@opencroft/server/values`. */
  type TemplateError,
  /** @deprecated Import `TemplatePlaceholder` from `@opencroft/server/values`. */
  type TemplatePlaceholder,
  /** @deprecated Import `takesSeveralTypes` from `@opencroft/server/values`. */
  takesSeveralTypes,
  /** @deprecated Import `typedValueOf` from `@opencroft/server/values`. */
  typedValueOf,
  /** @deprecated Import `typedValueProblem` from `@opencroft/server/values`. */
  typedValueProblem,
  /** @deprecated Import `typeGroupOf` from `@opencroft/server/values`. */
  typeGroupOf,
  /** @deprecated Import `UNRESOLVED_INPUTS_KEY` from `@opencroft/server/values`. */
  UNRESOLVED_INPUTS_KEY,
  /** @deprecated Import `VALUE_TYPES` from `@opencroft/server/values`. */
  VALUE_TYPES,
  /** @deprecated Import `Value` from `@opencroft/server/values`. */
  type Value,
  /** @deprecated Import `ValueHandle` from `@opencroft/server/values`. */
  type ValueHandle,
  /** @deprecated Import `ValueOption` from `@opencroft/server/values`. */
  type ValueOption,
  /** @deprecated Import `valueAsText` from `@opencroft/server/values`. */
  valueAsText,
  /** @deprecated Import `WiredValue` from `@opencroft/server/values`. */
  type WiredValue,
  /** @deprecated Import `wiredValueOf` from `@opencroft/server/values`. */
  wiredValueOf,
  /** @deprecated Import `withEnumCases` from `@opencroft/server/values`. */
  withEnumCases,
  /** @deprecated Import `withInputType` from `@opencroft/server/values`. */
  withInputType,
  /** @deprecated Import `withTypesNow` from `@opencroft/server/values`. */
  withTypesNow,
  /** @deprecated Import `withWiredInputs` from `@opencroft/server/values`. */
  withWiredInputs,
} from './values'

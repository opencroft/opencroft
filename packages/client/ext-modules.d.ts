// GENERATED from the extension API modules and the host's runtime surface by
// apps/opencroft/app/_authed/(extension-runtime)/_server/legacy-declarations.ts.
// Do not edit: run `npm run generate:legacy-declarations -w apps/opencroft`.
// The deprecated `@ext/host` and `@ext/ui` modules, for an extension typecheck.

declare module '@ext/host' {
  export {
    /** @deprecated Import `callAppAction` from `@opencroft/client/actions`. */
    callAppAction,
    /** @deprecated Import `dispatch` from `@opencroft/client/actions`. */
    dispatch,
    /** @deprecated Import `invoke` from `@opencroft/client/actions`. */
    invoke,
  } from '@opencroft/client/actions'
  export {
    /** @deprecated Import `useIsMobile` from `@opencroft/client/app`. */
    useIsMobile,
    /** @deprecated Import `useUrlParam` from `@opencroft/client/app`. */
    useUrlParam,
  } from '@opencroft/client/app'
  export {
    /** @deprecated Import `GraphCanvas` from `@opencroft/client/canvas`. */
    GraphCanvas,
    /** @deprecated Import `Handle` from `@opencroft/client/canvas`. */
    Handle,
    /** @deprecated Import `InputHandle` from `@opencroft/client/canvas`. */
    InputHandle,
    /** @deprecated Import `inspectorIntent` from `@opencroft/client/canvas`. */
    inspectorIntent,
    /** @deprecated Import `NodeCard` from `@opencroft/client/canvas`. */
    NodeCard,
    /** @deprecated Import `NodeCardContent` from `@opencroft/client/canvas`. */
    NodeCardContent,
    /** @deprecated Import `NodeCardHeader` from `@opencroft/client/canvas`. */
    NodeCardHeader,
    /** @deprecated Import `NodeFrame` from `@opencroft/client/canvas`. */
    NodeFrame,
    /** @deprecated Import `NodeResizer` from `@opencroft/client/canvas`. */
    NodeResizer,
    /** @deprecated Import `OutputHandle` from `@opencroft/client/canvas`. */
    OutputHandle,
    /** @deprecated Import `Position` from `@opencroft/client/canvas`. */
    Position,
    /** @deprecated Import `useGraphEdges` from `@opencroft/client/canvas`. */
    useGraphEdges,
    /** @deprecated Import `useGraphNodes` from `@opencroft/client/canvas`. */
    useGraphNodes,
    /** @deprecated Import `useInspectorIntent` from `@opencroft/client/canvas`. */
    useInspectorIntent,
    /** @deprecated Import `useNodeAccent` from `@opencroft/client/canvas`. */
    useNodeAccent,
    /** @deprecated Import `useNodeContext` from `@opencroft/client/canvas`. */
    useNodeContext,
    /** @deprecated Import `useOverlay` from `@opencroft/client/canvas`. */
    useOverlay,
    /** @deprecated Import `useReactFlow` from `@opencroft/client/canvas`. */
    useReactFlow,
    /** @deprecated Import `useUpdateNodeInternals` from `@opencroft/client/canvas`. */
    useUpdateNodeInternals,
  } from '@opencroft/client/canvas'
  export {
    /** @deprecated Import `ChatDock` from `@opencroft/client/chat`. */
    ChatDock,
    /** @deprecated Import `ChatSelector` from `@opencroft/client/chat`. */
    ChatSelector,
    /** @deprecated Import `describeMentionedAccounts` from `@opencroft/client/chat`. */
    describeMentionedAccounts,
    /** @deprecated Import `EmbeddedAgentChat` from `@opencroft/client/chat`. */
    EmbeddedAgentChat,
    /** @deprecated Import `SelectionProvider` from `@opencroft/client/chat`. */
    SelectionProvider,
    /** @deprecated Import `useChatDock` from `@opencroft/client/chat`. */
    useChatDock,
    /** @deprecated Import `useSelection` from `@opencroft/client/chat`. */
    useSelection,
  } from '@opencroft/client/chat'
  export {
    /** @deprecated Import `useDockerContainers` from `@opencroft/client/docker`. */
    useDockerContainers,
    /** @deprecated Import `useDockerSnapshotReceived` from `@opencroft/client/docker`. */
    useDockerSnapshotReceived,
    /** @deprecated Import `useSeedDockerContainers` from `@opencroft/client/docker`. */
    useSeedDockerContainers,
  } from '@opencroft/client/docker'
  export {
    /** @deprecated Import `defineExtension` from `@opencroft/client/extension`. */
    defineExtension,
  } from '@opencroft/client/extension'
  export {
    /** @deprecated Import `describeGraphRefs` from `@opencroft/client/graph`. */
    describeGraphRefs,
    /** @deprecated Import `subscribeGraphRefs` from `@opencroft/client/graph`. */
    subscribeGraphRefs,
  } from '@opencroft/client/graph'
  export {
    /** @deprecated Import `createStorage` from `@opencroft/client/storage`. */
    createStorage,
  } from '@opencroft/client/storage'
  export {
    /** @deprecated Import `broadcast` from `@opencroft/client/streams`. */
    broadcast,
    /** @deprecated Import `getStream` from `@opencroft/client/streams`. */
    getStream,
    /** @deprecated Import `subscribe` from `@opencroft/client/streams`. */
    subscribe,
  } from '@opencroft/client/streams'
  export {
    /** @deprecated Use `import React from 'react'` (or the hooks by name). */
    default as React,
  } from 'react'
  export {
    /** @deprecated Use `import { createPortal } from 'react-dom'`. */
    createPortal,
  } from 'react-dom'

  import * as iconsNamespace from 'lucide-react'

  export {
    /** @deprecated Import `agentInstructions` from `@opencroft/server/agents`. */
    agentInstructions,
  } from '@opencroft/server/agents'
  export {
    /** @deprecated Import `apps` from `@opencroft/server/apps`. */
    apps,
  } from '@opencroft/server/apps'
  export {
    /** @deprecated Import `groupChats` from `@opencroft/server/chat`. */
    groupChats,
    /** @deprecated Import `sendMessage` from `@opencroft/server/chat`. */
    sendMessage,
  } from '@opencroft/server/chat'
  export {
    /** @deprecated Import `collab` from `@opencroft/server/collab`. */
    collab,
  } from '@opencroft/server/collab'
  export {
    /** @deprecated Import `events` from `@opencroft/server/events`. */
    events,
  } from '@opencroft/server/events'
  export {
    /** @deprecated Import `graph` from `@opencroft/server/graph`. */
    graph,
  } from '@opencroft/server/graph'
  export {
    /** @deprecated Import `agents` from `@opencroft/server/people`. */
    agents,
    /** @deprecated Import `mcpTokens` from `@opencroft/server/people`. */
    mcpTokens,
    /** @deprecated Import `mentions` from `@opencroft/server/people`. */
    mentions,
    /** @deprecated Import `users` from `@opencroft/server/people`. */
    users,
  } from '@opencroft/server/people'
  export {
    /** @deprecated Import `credentialRedactor` from `@opencroft/server/secrets`. */
    credentialRedactor,
    /** @deprecated Import `secrets` from `@opencroft/server/secrets`. */
    secrets,
  } from '@opencroft/server/secrets'
  export {
    /** @deprecated Import `settings` from `@opencroft/server/settings`. */
    settings,
  } from '@opencroft/server/settings'
  export {
    /** @deprecated Import `spaces` from `@opencroft/server/spaces`. */
    spaces,
  } from '@opencroft/server/spaces'
  export {
    /** @deprecated Import `cacheDir` from `@opencroft/server/storage`. */
    cacheDir,
    /** @deprecated Import `dataDir` from `@opencroft/server/storage`. */
    dataDir,
    /** @deprecated Import `storage` from `@opencroft/server/storage`. */
    storage,
  } from '@opencroft/server/storage'
  export {
    /** @deprecated Import `crypto` from `@opencroft/server/system`. */
    crypto,
    /** @deprecated Import `exec` from `@opencroft/server/system`. */
    exec,
    /** @deprecated Import `execFile` from `@opencroft/server/system`. */
    execFile,
    /** @deprecated Import `fs` from `@opencroft/server/system`. */
    fs,
    /** @deprecated Import `instanceId` from `@opencroft/server/system`. */
    instanceId,
    /** @deprecated Import `os` from `@opencroft/server/system`. */
    os,
    /** @deprecated Import `path` from `@opencroft/server/system`. */
    path,
  } from '@opencroft/server/system'
  export {
    /** @deprecated Import `agentRefusalOf` from `@opencroft/server/terminal`. */
    agentRefusalOf,
    /** @deprecated Import `execContext` from `@opencroft/server/terminal`. */
    execContext,
    /** @deprecated Import `ssh` from `@opencroft/server/terminal`. */
    ssh,
    /** @deprecated Import `terminal` from `@opencroft/server/terminal`. */
    terminal,
  } from '@opencroft/server/terminal'
  export {
    /** @deprecated Import `usage` from `@opencroft/server/usage`. */
    usage,
  } from '@opencroft/server/usage'
  export {
    /** @deprecated Import `AWAITING_RUN_KEY` from `@opencroft/server/values`. */
    AWAITING_RUN_KEY,
    /** @deprecated Import `acceptedTypesPhrase` from `@opencroft/server/values`. */
    acceptedTypesPhrase,
    /** @deprecated Import `awaitingRunOf` from `@opencroft/server/values`. */
    awaitingRunOf,
    /** @deprecated Import `BOOLEAN_TYPE` from `@opencroft/server/values`. */
    BOOLEAN_TYPE,
    /** @deprecated Import `compilePattern` from `@opencroft/server/values`. */
    compilePattern,
    /** @deprecated Import `DEFAULT_FILE_COLLISION` from `@opencroft/server/values`. */
    DEFAULT_FILE_COLLISION,
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
    /** @deprecated Import `handleTakes` from `@opencroft/server/values`. */
    handleTakes,
    /** @deprecated Import `handleTypesConnect` from `@opencroft/server/values`. */
    handleTypesConnect,
    /** @deprecated Import `INPUT_TYPES_KEY` from `@opencroft/server/values`. */
    INPUT_TYPES_KEY,
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
    /** @deprecated Import `PRIMITIVE_TYPES` from `@opencroft/server/values`. */
    PRIMITIVE_TYPES,
    /** @deprecated Import `parseExpression` from `@opencroft/server/values`. */
    parseExpression,
    /** @deprecated Import `parsePath` from `@opencroft/server/values`. */
    parsePath,
    /** @deprecated Import `parseTemplate` from `@opencroft/server/values`. */
    parseTemplate,
    /** @deprecated Import `RESOLVED_CONTEXTS_KEY` from `@opencroft/server/values`. */
    RESOLVED_CONTEXTS_KEY,
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
    /** @deprecated Import `switchCaseOutput` from `@opencroft/server/values`. */
    switchCaseOutput,
    /** @deprecated Import `switchCasesOf` from `@opencroft/server/values`. */
    switchCasesOf,
    /** @deprecated Import `switchConditionType` from `@opencroft/server/values`. */
    switchConditionType,
    /** @deprecated Import `switchOutput` from `@opencroft/server/values`. */
    switchOutput,
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
    /** @deprecated Import `valueAsText` from `@opencroft/server/values`. */
    valueAsText,
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
  } from '@opencroft/server/values'
  export {
    /** @deprecated Use `import { toast } from 'sonner'`. */
    toast,
  } from 'sonner'

  export {
    /** @deprecated Use each icon by name from `lucide-react`. */
    iconsNamespace as icons,
  }
  /** @deprecated Import `absoluteUrl` from `@opencroft/client/extension` in client code, or `@opencroft/server/extension` in server code. */
  export const absoluteUrl: typeof import('@opencroft/client/extension').absoluteUrl &
    typeof import('@opencroft/server/extension').absoluteUrl
  /** @deprecated Import `assetUrl` from `@opencroft/client/extension` in client code, or `@opencroft/server/extension` in server code. */
  export const assetUrl: typeof import('@opencroft/client/extension').assetUrl &
    typeof import('@opencroft/server/extension').assetUrl
  /** @deprecated Import `extensionId` from `@opencroft/client/extension` in client code, or `@opencroft/server/extension` in server code. */
  export const extensionId: typeof import('@opencroft/client/extension').extensionId &
    typeof import('@opencroft/server/extension').extensionId
  /** @deprecated Import `routeUrl` from `@opencroft/client/extension` in client code, or `@opencroft/server/extension` in server code. */
  export const routeUrl: typeof import('@opencroft/client/extension').routeUrl &
    typeof import('@opencroft/server/extension').routeUrl
  /** @deprecated Import `urlBase` from `@opencroft/client/extension` in client code, or `@opencroft/server/extension` in server code. */
  export const urlBase: typeof import('@opencroft/client/extension').urlBase &
    typeof import('@opencroft/server/extension').urlBase
  export type {
    /** @deprecated Import `AppComponentProps` from `@opencroft/client/app`. */
    AppComponentProps,
    /** @deprecated Import `AppDefinition` from `@opencroft/client/app`. */
    AppDefinition,
    /** @deprecated Import `AppFormProps` from `@opencroft/client/app`. */
    AppFormProps,
    /** @deprecated Import `AppLinkProps` from `@opencroft/client/app`. */
    AppLinkProps,
    /** @deprecated Import `AppLocation` from `@opencroft/client/app`. */
    AppLocation,
    /** @deprecated Import `AppNavigateOptions` from `@opencroft/client/app`. */
    AppNavigateOptions,
    /** @deprecated Import `AppSidebarProps` from `@opencroft/client/app`. */
    AppSidebarProps,
    /** @deprecated Import `UrlParamControls` from `@opencroft/client/app`. */
    UrlParamControls,
    /** @deprecated Import `UrlParamWriteOptions` from `@opencroft/client/app`. */
    UrlParamWriteOptions,
  } from '@opencroft/client/app'
  export type {
    /** @deprecated Import `CanvasFrameProps` from `@opencroft/client/canvas`. */
    CanvasFrameProps,
    /** @deprecated Import `CommandBarNode` from `@opencroft/client/canvas`. */
    CommandBarNode,
    /** @deprecated Import `CommandModeDefinition` from `@opencroft/client/canvas`. */
    CommandModeDefinition,
    /** @deprecated Import `CommandModeProps` from `@opencroft/client/canvas`. */
    CommandModeProps,
    /** @deprecated Import `CommandModeShortcut` from `@opencroft/client/canvas`. */
    CommandModeShortcut,
    /** @deprecated Import `ContainingNode` from `@opencroft/client/canvas`. */
    ContainingNode,
    /** @deprecated Import `ExtensionComponentProps` from `@opencroft/client/canvas`. */
    ExtensionComponentProps,
    /** @deprecated Import `ExtensionContextType` from `@opencroft/client/canvas`. */
    ExtensionContextType,
    /** @deprecated Import `ExtensionHandle` from `@opencroft/client/canvas`. */
    ExtensionHandle,
    /** @deprecated Import `ExtensionHandleType` from `@opencroft/client/canvas`. */
    ExtensionHandleType,
    /** @deprecated Import `ExtensionInspectorProps` from `@opencroft/client/canvas`. */
    ExtensionInspectorProps,
    /** @deprecated Import `HandlePinProps` from `@opencroft/client/canvas`. */
    HandlePinProps,
    /** @deprecated Import `InspectorIntent` from `@opencroft/client/canvas`. */
    InspectorIntent,
    /** @deprecated Import `InspectorTab` from `@opencroft/client/canvas`. */
    InspectorTab,
    /** @deprecated Import `NodeContextMenuContext` from `@opencroft/client/canvas`. */
    NodeContextMenuContext,
    /** @deprecated Import `NodeContextMenuItem` from `@opencroft/client/canvas`. */
    NodeContextMenuItem,
    /** @deprecated Import `NodeDefinition` from `@opencroft/client/canvas`. */
    NodeDefinition,
    /** @deprecated Import `NodeErrorEdge` from `@opencroft/client/canvas`. */
    NodeErrorEdge,
    /** @deprecated Import `OverlayControl` from `@opencroft/client/canvas`. */
    OverlayControl,
    /** @deprecated Import `ResolvedContext` from `@opencroft/client/canvas`. */
    ResolvedContext,
    /** @deprecated Import `WindowShellProps` from `@opencroft/client/canvas`. */
    WindowShellProps,
  } from '@opencroft/client/canvas'
  export type {
    /** @deprecated Import `AgentChatInputControl` from `@opencroft/client/chat`. */
    AgentChatInputControl,
    /** @deprecated Import `AgentChatInputControlProps` from `@opencroft/client/chat`. */
    AgentChatInputControlProps,
    /** @deprecated Import `AgentChatMessage` from `@opencroft/client/chat`. */
    AgentChatMessage,
    /** @deprecated Import `AgentChatStatusIndicator` from `@opencroft/client/chat`. */
    AgentChatStatusIndicator,
    /** @deprecated Import `ChatDockControl` from `@opencroft/client/chat`. */
    ChatDockControl,
    /** @deprecated Import `ChatDockProps` from `@opencroft/client/chat`. */
    ChatDockProps,
    /** @deprecated Import `ChatSelectorProps` from `@opencroft/client/chat`. */
    ChatSelectorProps,
    /** @deprecated Import `EmbeddedAgentChatProps` from `@opencroft/client/chat`. */
    EmbeddedAgentChatProps,
    /** @deprecated Import `EmbeddedChatSelection` from `@opencroft/client/chat`. */
    EmbeddedChatSelection,
    /** @deprecated Import `LineRange` from `@opencroft/client/chat`. */
    LineRange,
    /** @deprecated Import `MentionedAccount` from `@opencroft/client/chat`. */
    MentionedAccount,
    /** @deprecated Import `Selection` from `@opencroft/client/chat`. */
    Selection,
    /** @deprecated Import `SelectionContextValue` from `@opencroft/client/chat`. */
    SelectionContextValue,
    /** @deprecated Import `SelectionItem` from `@opencroft/client/chat`. */
    SelectionItem,
    /** @deprecated Import `UserSelection` from `@opencroft/client/chat`. */
    UserSelection,
  } from '@opencroft/client/chat'
  export type {
    /** @deprecated Import `CodeBlockEditorProps` from `@opencroft/client/code`. */
    CodeBlockEditorProps,
    /** @deprecated Import `CodeBlockProps` from `@opencroft/client/code`. */
    CodeBlockProps,
    /** @deprecated Import `CodeEditorDiffMode` from `@opencroft/client/code`. */
    CodeEditorDiffMode,
    /** @deprecated Import `CodeEditorHideUnchangedRegions` from `@opencroft/client/code`. */
    CodeEditorHideUnchangedRegions,
    /** @deprecated Import `CodeEditorLanguage` from `@opencroft/client/code`. */
    CodeEditorLanguage,
    /** @deprecated Import `CodeEditorOnMount` from `@opencroft/client/code`. */
    CodeEditorOnMount,
    /** @deprecated Import `CodeEditorProps` from `@opencroft/client/code`. */
    CodeEditorProps,
    /** @deprecated Import `MonacoCodeEditor` from `@opencroft/client/code`. */
    MonacoCodeEditor,
    /** @deprecated Import `MonacoDiffEditor` from `@opencroft/client/code`. */
    MonacoDiffEditor,
    /** @deprecated Import `MonacoNamespace` from `@opencroft/client/code`. */
    MonacoNamespace,
  } from '@opencroft/client/code'
  export type {
    /** @deprecated Import `DockerContainerSnapshot` from `@opencroft/client/docker`. */
    DockerContainerSnapshot,
  } from '@opencroft/client/docker'
  export type {
    /** @deprecated Import `ExtensionDeclaration` from `@opencroft/client/extension`. */
    ExtensionDeclaration,
    /** @deprecated Import `ExtensionDeclarationManifest` from `@opencroft/client/extension`. */
    ExtensionDeclarationManifest,
    /** @deprecated Import `ProvidedPoints` from `@opencroft/client/extension`. */
    ProvidedPoints,
    /** @deprecated Import `RightSidebarPanel` from `@opencroft/client/extension`. */
    RightSidebarPanel,
    /** @deprecated Import `SettingsPageDefinition` from `@opencroft/client/extension`. */
    SettingsPageDefinition,
  } from '@opencroft/client/extension'
  export type {
    /** @deprecated Import `GraphRefDescription` from `@opencroft/client/graph`. */
    GraphRefDescription,
    /** @deprecated Import `NodeRefProps` from `@opencroft/client/graph`. */
    NodeRefProps,
  } from '@opencroft/client/graph'
  export type {
    /** @deprecated Import `MarkdownDiffViewProps` from `@opencroft/client/markdown`. */
    MarkdownDiffViewProps,
    /** @deprecated Import `MarkdownEditorOwnDocument` from `@opencroft/client/markdown`. */
    MarkdownEditorOwnDocument,
    /** @deprecated Import `MarkdownEditorProps` from `@opencroft/client/markdown`. */
    MarkdownEditorProps,
    /** @deprecated Import `MarkdownEditorSharedDocument` from `@opencroft/client/markdown`. */
    MarkdownEditorSharedDocument,
    /** @deprecated Import `MarkdownEditorSurfaceProps` from `@opencroft/client/markdown`. */
    MarkdownEditorSurfaceProps,
    /** @deprecated Import `MarkdownEditorToolbarGroup` from `@opencroft/client/markdown`. */
    MarkdownEditorToolbarGroup,
    /** @deprecated Import `MarkdownProps` from `@opencroft/client/markdown`. */
    MarkdownProps,
    /** @deprecated Import `MarkdownReference` from `@opencroft/client/markdown`. */
    MarkdownReference,
    /** @deprecated Import `MarkdownReferenceMenuItem` from `@opencroft/client/markdown`. */
    MarkdownReferenceMenuItem,
    /** @deprecated Import `MarkdownReferenceTone` from `@opencroft/client/markdown`. */
    MarkdownReferenceTone,
    /** @deprecated Import `MarkdownResolver` from `@opencroft/client/markdown`. */
    MarkdownResolver,
    /** @deprecated Import `MermaidDiagramProps` from `@opencroft/client/markdown`. */
    MermaidDiagramProps,
  } from '@opencroft/client/markdown'
  export type {
    /** @deprecated Import `NamedValue` from `@opencroft/client/secrets`. */
    NamedValue,
    /** @deprecated Import `SecretSelectorProps` from `@opencroft/client/secrets`. */
    SecretSelectorProps,
    /** @deprecated Import `SecretValueFieldProps` from `@opencroft/client/secrets`. */
    SecretValueFieldProps,
    /** @deprecated Import `SecretValueTableProps` from `@opencroft/client/secrets`. */
    SecretValueTableProps,
  } from '@opencroft/client/secrets'
  export type {
    /** @deprecated Import `ExtensionStorage` from `@opencroft/client/storage`. */
    ExtensionStorage,
  } from '@opencroft/client/storage'
  export type {
    /** @deprecated Import `Stream` from `@opencroft/client/streams`. */
    Stream,
    /** @deprecated Import `TextChunk` from `@opencroft/client/streams`. */
    TextChunk,
  } from '@opencroft/client/streams'
  export type {
    /** @deprecated Import `TerminalConfig` from `@opencroft/client/terminal`. */
    TerminalConfig,
    /** @deprecated Import `TerminalListProps` from `@opencroft/client/terminal`. */
    TerminalListProps,
    /** @deprecated Import `TerminalProps` from `@opencroft/client/terminal`. */
    TerminalProps,
    /** @deprecated Import `TerminalRefProps` from `@opencroft/client/terminal`. */
    TerminalRefProps,
    /** @deprecated Import `TerminalSelectorProps` from `@opencroft/client/terminal`. */
    TerminalSelectorProps,
    /** @deprecated Import `TerminalSourceOwner` from `@opencroft/client/terminal`. */
    TerminalSourceOwner,
    /** @deprecated Import `TerminalStatus` from `@opencroft/client/terminal`. */
    TerminalStatus,
  } from '@opencroft/client/terminal'
  export type {
    /** @deprecated Import `AccountCardProps` from `@opencroft/client/ui`. */
    AccountCardProps,
    /** @deprecated Import `AdaptivePopupProps` from `@opencroft/client/ui`. */
    AdaptivePopupProps,
    /** @deprecated Import `AgentAvatarSize` from `@opencroft/client/ui`. */
    AgentAvatarSize,
    /** @deprecated Import `AgentJobRef` from `@opencroft/client/ui`. */
    AgentJobRef,
    /** @deprecated Import `AgentRef` from `@opencroft/client/ui`. */
    AgentRef,
    /** @deprecated Import `AgentSessionGroup` from `@opencroft/client/ui`. */
    AgentSessionGroup,
    /** @deprecated Import `AgentSessionListProps` from `@opencroft/client/ui`. */
    AgentSessionListProps,
    /** @deprecated Import `AgentSessionSummary` from `@opencroft/client/ui`. */
    AgentSessionSummary,
    /** @deprecated Import `AlignItems` from `@opencroft/client/ui`. */
    AlignItems,
    /** @deprecated Import `ApiToken` from `@opencroft/client/ui`. */
    ApiToken,
    /** @deprecated Import `ApiTokenCreateFormProps` from `@opencroft/client/ui`. */
    ApiTokenCreateFormProps,
    /** @deprecated Import `ApiTokenExpiryOption` from `@opencroft/client/ui`. */
    ApiTokenExpiryOption,
    /** @deprecated Import `ApiTokenListProps` from `@opencroft/client/ui`. */
    ApiTokenListProps,
    /** @deprecated Import `ApiTokenRevealProps` from `@opencroft/client/ui`. */
    ApiTokenRevealProps,
    /** @deprecated Import `CallActionActionOption` from `@opencroft/client/ui`. */
    CallActionActionOption,
    /** @deprecated Import `CallActionAppOption` from `@opencroft/client/ui`. */
    CallActionAppOption,
    /** @deprecated Import `CallActionNodeOption` from `@opencroft/client/ui`. */
    CallActionNodeOption,
    /** @deprecated Import `CallActionTargetProps` from `@opencroft/client/ui`. */
    CallActionTargetProps,
    /** @deprecated Import `CallActionTargetValue` from `@opencroft/client/ui`. */
    CallActionTargetValue,
    /** @deprecated Import `CarouselApi` from `@opencroft/client/ui`. */
    CarouselApi,
    /** @deprecated Import `ChartConfig` from `@opencroft/client/ui`. */
    ChartConfig,
    /** @deprecated Import `ChatInputProps` from `@opencroft/client/ui`. */
    ChatInputProps,
    /** @deprecated Import `ChatMessageProps` from `@opencroft/client/ui`. */
    ChatMessageProps,
    /** @deprecated Import `ControlledInputProps` from `@opencroft/client/ui`. */
    ControlledInputProps,
    /** @deprecated Import `ControlledTextareaProps` from `@opencroft/client/ui`. */
    ControlledTextareaProps,
    /** @deprecated Import `EnvironmentTableProps` from `@opencroft/client/ui`. */
    EnvironmentTableProps,
    /** @deprecated Import `EnvironmentValue` from `@opencroft/client/ui`. */
    EnvironmentValue,
    /** @deprecated Import `EnvironmentVariable` from `@opencroft/client/ui`. */
    EnvironmentVariable,
    /** @deprecated Import `ExampleFrameProps` from `@opencroft/client/ui`. */
    ExampleFrameProps,
    /** @deprecated Import `FieldHintProps` from `@opencroft/client/ui`. */
    FieldHintProps,
    /** @deprecated Import `FixedAreaProps` from `@opencroft/client/ui`. */
    FixedAreaProps,
    /** @deprecated Import `FlexDirection` from `@opencroft/client/ui`. */
    FlexDirection,
    /** @deprecated Import `FlexProps` from `@opencroft/client/ui`. */
    FlexProps,
    /** @deprecated Import `GridProps` from `@opencroft/client/ui`. */
    GridProps,
    /** @deprecated Import `GridSize` from `@opencroft/client/ui`. */
    GridSize,
    /** @deprecated Import `GridSizeSwitcherProps` from `@opencroft/client/ui`. */
    GridSizeSwitcherProps,
    /** @deprecated Import `ImageAreaProps` from `@opencroft/client/ui`. */
    ImageAreaProps,
    /** @deprecated Import `ImageComparisonProps` from `@opencroft/client/ui`. */
    ImageComparisonProps,
    /** @deprecated Import `ImageComparisonSide` from `@opencroft/client/ui`. */
    ImageComparisonSide,
    /** @deprecated Import `JustifyContent` from `@opencroft/client/ui`. */
    JustifyContent,
    /** @deprecated Import `MenuLayoutProps` from `@opencroft/client/ui`. */
    MenuLayoutProps,
    /** @deprecated Import `MenuWidth` from `@opencroft/client/ui`. */
    MenuWidth,
    /** @deprecated Import `NamedSectionProps` from `@opencroft/client/ui`. */
    NamedSectionProps,
    /** @deprecated Import `NodeRow` from `@opencroft/client/ui`. */
    NodeRow,
    /** @deprecated Import `NodeRowListProps` from `@opencroft/client/ui`. */
    NodeRowListProps,
    /** @deprecated Import `NodeRowSlot` from `@opencroft/client/ui`. */
    NodeRowSlot,
    /** @deprecated Import `NodeValue` from `@opencroft/client/ui`. */
    NodeValue,
    /** @deprecated Import `NodeValueInputProps` from `@opencroft/client/ui`. */
    NodeValueInputProps,
    /** @deprecated Import `NodeValueKind` from `@opencroft/client/ui`. */
    NodeValueKind,
    /** @deprecated Import `NodeValueOption` from `@opencroft/client/ui`. */
    NodeValueOption,
    /** @deprecated Import `PageProps` from `@opencroft/client/ui`. */
    PageProps,
    /** @deprecated Import `PopupContentProps` from `@opencroft/client/ui`. */
    PopupContentProps,
    /** @deprecated Import `PopupFooterProps` from `@opencroft/client/ui`. */
    PopupFooterProps,
    /** @deprecated Import `PopupHeaderProps` from `@opencroft/client/ui`. */
    PopupHeaderProps,
    /** @deprecated Import `PopupRecyclingContentProps` from `@opencroft/client/ui`. */
    PopupRecyclingContentProps,
    /** @deprecated Import `PopupSubHeaderProps` from `@opencroft/client/ui`. */
    PopupSubHeaderProps,
    /** @deprecated Import `RunHistoryEntry` from `@opencroft/client/ui`. */
    RunHistoryEntry,
    /** @deprecated Import `RunStatus` from `@opencroft/client/ui`. */
    RunStatus,
    /** @deprecated Import `SaveFileCollision` from `@opencroft/client/ui`. */
    SaveFileCollision,
    /** @deprecated Import `SaveFileFieldsProps` from `@opencroft/client/ui`. */
    SaveFileFieldsProps,
    /** @deprecated Import `SaveFileFolderListing` from `@opencroft/client/ui`. */
    SaveFileFolderListing,
    /** @deprecated Import `SaveFilePreview` from `@opencroft/client/ui`. */
    SaveFilePreview,
    /** @deprecated Import `SaveFileToken` from `@opencroft/client/ui`. */
    SaveFileToken,
    /** @deprecated Import `ScheduleMode` from `@opencroft/client/ui`. */
    ScheduleMode,
    /** @deprecated Import `ScheduleRule` from `@opencroft/client/ui`. */
    ScheduleRule,
    /** @deprecated Import `SchedulesProps` from `@opencroft/client/ui`. */
    SchedulesProps,
    /** @deprecated Import `ScheduleUnit` from `@opencroft/client/ui`. */
    ScheduleUnit,
    /** @deprecated Import `ScrollAreaScrollbars` from `@opencroft/client/ui`. */
    ScrollAreaScrollbars,
    /** @deprecated Import `SecretInputProps` from `@opencroft/client/ui`. */
    SecretInputProps,
    /** @deprecated Import `SimpleSchedule` from `@opencroft/client/ui`. */
    SimpleSchedule,
    /** @deprecated Import `StatusIndicatorProps` from `@opencroft/client/ui`. */
    StatusIndicatorProps,
    /** @deprecated Import `StatusVariant` from `@opencroft/client/ui`. */
    StatusVariant,
    /** @deprecated Import `TypingDotsProps` from `@opencroft/client/ui`. */
    TypingDotsProps,
    /** @deprecated Import `UpcomingRun` from `@opencroft/client/ui`. */
    UpcomingRun,
  } from '@opencroft/client/ui'
  export type {
    /** @deprecated Import `AcceptedTypes` from `@opencroft/client/values`. */
    AcceptedTypes,
    /** @deprecated Import `CompiledPattern` from `@opencroft/client/values`. */
    CompiledPattern,
    /** @deprecated Import `EnumCasesField` from `@opencroft/client/values`. */
    EnumCasesField,
    /** @deprecated Import `EnumCasesOf` from `@opencroft/client/values`. */
    EnumCasesOf,
    /** @deprecated Import `EvaluateExpressionResult` from `@opencroft/client/values`. */
    EvaluateExpressionResult,
    /** @deprecated Import `ExpressionError` from `@opencroft/client/values`. */
    ExpressionError,
    /** @deprecated Import `ExpressionNode` from `@opencroft/client/values`. */
    ExpressionNode,
    /** @deprecated Import `ExpressionType` from `@opencroft/client/values`. */
    ExpressionType,
    /** @deprecated Import `ExpressionTypes` from `@opencroft/client/values`. */
    ExpressionTypes,
    /** @deprecated Import `FileCollision` from `@opencroft/client/values`. */
    FileCollision,
    /** @deprecated Import `FileNameToken` from `@opencroft/client/values`. */
    FileNameToken,
    /** @deprecated Import `FileSaveSettings` from `@opencroft/client/values`. */
    FileSaveSettings,
    /** @deprecated Import `FormatTemplateResult` from `@opencroft/client/values`. */
    FormatTemplateResult,
    /** @deprecated Import `GroupType` from `@opencroft/client/values`. */
    GroupType,
    /** @deprecated Import `InlineValueFields` from `@opencroft/client/values`. */
    InlineValueFields,
    /** @deprecated Import `ObjectValue` from `@opencroft/client/values`. */
    ObjectValue,
    /** @deprecated Import `ParsedExpression` from `@opencroft/client/values`. */
    ParsedExpression,
    /** @deprecated Import `ParsedTemplate` from `@opencroft/client/values`. */
    ParsedTemplate,
    /** @deprecated Import `ParseExpressionResult` from `@opencroft/client/values`. */
    ParseExpressionResult,
    /** @deprecated Import `ParsePathResult` from `@opencroft/client/values`. */
    ParsePathResult,
    /** @deprecated Import `Pattern` from `@opencroft/client/values`. */
    Pattern,
    /** @deprecated Import `PatternGroup` from `@opencroft/client/values`. */
    PatternGroup,
    /** @deprecated Import `PatternMatch` from `@opencroft/client/values`. */
    PatternMatch,
    /** @deprecated Import `PrimitiveValue` from `@opencroft/client/values`. */
    PrimitiveValue,
    /** @deprecated Import `ReadPathResult` from `@opencroft/client/values`. */
    ReadPathResult,
    /** @deprecated Import `ReplaceResult` from `@opencroft/client/values`. */
    ReplaceResult,
    /** @deprecated Import `ResolvedInputEntry` from `@opencroft/client/values`. */
    ResolvedInputEntry,
    /** @deprecated Import `SwitchCase` from `@opencroft/client/values`. */
    SwitchCase,
    /** @deprecated Import `SwitchOutputResult` from `@opencroft/client/values`. */
    SwitchOutputResult,
    /** @deprecated Import `SwitchSettings` from `@opencroft/client/values`. */
    SwitchSettings,
    /** @deprecated Import `TemplateError` from `@opencroft/client/values`. */
    TemplateError,
    /** @deprecated Import `TemplatePlaceholder` from `@opencroft/client/values`. */
    TemplatePlaceholder,
    /** @deprecated Import `Value` from `@opencroft/client/values`. */
    Value,
    /** @deprecated Import `ValueHandle` from `@opencroft/client/values`. */
    ValueHandle,
    /** @deprecated Import `ValueOption` from `@opencroft/client/values`. */
    ValueOption,
    /** @deprecated Import `WiredValue` from `@opencroft/client/values`. */
    WiredValue,
  } from '@opencroft/client/values'

  /**
   * @deprecated The whole host: the server host in server code, the client host
   * in client code. Import each capability from its module of
   * `@opencroft/server` or `@opencroft/client` instead.
   */
  const host: import('@opencroft/server').ExtensionServerHost & typeof import('@opencroft/client').legacy
  export default host
}

declare module '@ext/ui' {
  export type {
    /** @deprecated Import `AppComponentProps` from `@opencroft/client/app`. */
    AppComponentProps,
    /** @deprecated Import `AppDefinition` from `@opencroft/client/app`. */
    AppDefinition,
    /** @deprecated Import `AppFormProps` from `@opencroft/client/app`. */
    AppFormProps,
    /** @deprecated Import `AppLinkProps` from `@opencroft/client/app`. */
    AppLinkProps,
    /** @deprecated Import `AppLocation` from `@opencroft/client/app`. */
    AppLocation,
    /** @deprecated Import `AppNavigateOptions` from `@opencroft/client/app`. */
    AppNavigateOptions,
    /** @deprecated Import `AppSidebarProps` from `@opencroft/client/app`. */
    AppSidebarProps,
    /** @deprecated Import `UrlParamControls` from `@opencroft/client/app`. */
    UrlParamControls,
    /** @deprecated Import `UrlParamWriteOptions` from `@opencroft/client/app`. */
    UrlParamWriteOptions,
  } from '@opencroft/client/app'
  export {
    /** @deprecated Import `AppActions` from `@opencroft/client/app`. */
    AppActions,
    /** @deprecated Import `AppLink` from `@opencroft/client/app`. */
    AppLink,
    /** @deprecated Import `AppSidebar` from `@opencroft/client/app`. */
    AppSidebar,
    /** @deprecated Import `AppTitle` from `@opencroft/client/app`. */
    AppTitle,
    /** @deprecated Import `AppToolbar` from `@opencroft/client/app`. */
    AppToolbar,
    /** @deprecated Import `useAppAddressHref` from `@opencroft/client/app`. */
    useAppAddressHref,
    /** @deprecated Import `useAppHref` from `@opencroft/client/app`. */
    useAppHref,
    /** @deprecated Import `useAppLocation` from `@opencroft/client/app`. */
    useAppLocation,
    /** @deprecated Import `useAppNavigate` from `@opencroft/client/app`. */
    useAppNavigate,
    /** @deprecated Import `useOpenApp` from `@opencroft/client/app`. */
    useOpenApp,
  } from '@opencroft/client/app'
  export type {
    /** @deprecated Import `CanvasFrameProps` from `@opencroft/client/canvas`. */
    CanvasFrameProps,
    /** @deprecated Import `CommandBarNode` from `@opencroft/client/canvas`. */
    CommandBarNode,
    /** @deprecated Import `CommandModeDefinition` from `@opencroft/client/canvas`. */
    CommandModeDefinition,
    /** @deprecated Import `CommandModeProps` from `@opencroft/client/canvas`. */
    CommandModeProps,
    /** @deprecated Import `CommandModeShortcut` from `@opencroft/client/canvas`. */
    CommandModeShortcut,
    /** @deprecated Import `ContainingNode` from `@opencroft/client/canvas`. */
    ContainingNode,
    /** @deprecated Import `ExtensionComponentProps` from `@opencroft/client/canvas`. */
    ExtensionComponentProps,
    /** @deprecated Import `ExtensionContextType` from `@opencroft/client/canvas`. */
    ExtensionContextType,
    /** @deprecated Import `ExtensionHandle` from `@opencroft/client/canvas`. */
    ExtensionHandle,
    /** @deprecated Import `ExtensionHandleType` from `@opencroft/client/canvas`. */
    ExtensionHandleType,
    /** @deprecated Import `ExtensionInspectorProps` from `@opencroft/client/canvas`. */
    ExtensionInspectorProps,
    /** @deprecated Import `HandlePinProps` from `@opencroft/client/canvas`. */
    HandlePinProps,
    /** @deprecated Import `InspectorIntent` from `@opencroft/client/canvas`. */
    InspectorIntent,
    /** @deprecated Import `InspectorTab` from `@opencroft/client/canvas`. */
    InspectorTab,
    /** @deprecated Import `NodeContextMenuContext` from `@opencroft/client/canvas`. */
    NodeContextMenuContext,
    /** @deprecated Import `NodeContextMenuItem` from `@opencroft/client/canvas`. */
    NodeContextMenuItem,
    /** @deprecated Import `NodeDefinition` from `@opencroft/client/canvas`. */
    NodeDefinition,
    /** @deprecated Import `NodeErrorEdge` from `@opencroft/client/canvas`. */
    NodeErrorEdge,
    /** @deprecated Import `OverlayControl` from `@opencroft/client/canvas`. */
    OverlayControl,
    /** @deprecated Import `ResolvedContext` from `@opencroft/client/canvas`. */
    ResolvedContext,
    /** @deprecated Import `WindowShellProps` from `@opencroft/client/canvas`. */
    WindowShellProps,
  } from '@opencroft/client/canvas'
  export {
    /** @deprecated Import `CommandBar` from `@opencroft/client/canvas`. */
    CommandBar,
    /** @deprecated Import `CommandBarMenu` from `@opencroft/client/canvas`. */
    CommandBarMenu,
    /** @deprecated Import `CommandBarMenuItem` from `@opencroft/client/canvas`. */
    CommandBarMenuItem,
  } from '@opencroft/client/canvas'
  export type {
    /** @deprecated Import `AgentChatInputControl` from `@opencroft/client/chat`. */
    AgentChatInputControl,
    /** @deprecated Import `AgentChatInputControlProps` from `@opencroft/client/chat`. */
    AgentChatInputControlProps,
    /** @deprecated Import `AgentChatMessage` from `@opencroft/client/chat`. */
    AgentChatMessage,
    /** @deprecated Import `AgentChatStatusIndicator` from `@opencroft/client/chat`. */
    AgentChatStatusIndicator,
    /** @deprecated Import `ChatDockControl` from `@opencroft/client/chat`. */
    ChatDockControl,
    /** @deprecated Import `ChatDockProps` from `@opencroft/client/chat`. */
    ChatDockProps,
    /** @deprecated Import `ChatSelectorProps` from `@opencroft/client/chat`. */
    ChatSelectorProps,
    /** @deprecated Import `EmbeddedAgentChatProps` from `@opencroft/client/chat`. */
    EmbeddedAgentChatProps,
    /** @deprecated Import `EmbeddedChatSelection` from `@opencroft/client/chat`. */
    EmbeddedChatSelection,
    /** @deprecated Import `LineRange` from `@opencroft/client/chat`. */
    LineRange,
    /** @deprecated Import `MentionedAccount` from `@opencroft/client/chat`. */
    MentionedAccount,
    /** @deprecated Import `Selection` from `@opencroft/client/chat`. */
    Selection,
    /** @deprecated Import `SelectionContextValue` from `@opencroft/client/chat`. */
    SelectionContextValue,
    /** @deprecated Import `SelectionItem` from `@opencroft/client/chat`. */
    SelectionItem,
    /** @deprecated Import `UserSelection` from `@opencroft/client/chat`. */
    UserSelection,
  } from '@opencroft/client/chat'
  export type {
    /** @deprecated Import `CodeBlockEditorProps` from `@opencroft/client/code`. */
    CodeBlockEditorProps,
    /** @deprecated Import `CodeBlockProps` from `@opencroft/client/code`. */
    CodeBlockProps,
    /** @deprecated Import `CodeEditorDiffMode` from `@opencroft/client/code`. */
    CodeEditorDiffMode,
    /** @deprecated Import `CodeEditorHideUnchangedRegions` from `@opencroft/client/code`. */
    CodeEditorHideUnchangedRegions,
    /** @deprecated Import `CodeEditorLanguage` from `@opencroft/client/code`. */
    CodeEditorLanguage,
    /** @deprecated Import `CodeEditorOnMount` from `@opencroft/client/code`. */
    CodeEditorOnMount,
    /** @deprecated Import `CodeEditorProps` from `@opencroft/client/code`. */
    CodeEditorProps,
    /** @deprecated Import `MonacoCodeEditor` from `@opencroft/client/code`. */
    MonacoCodeEditor,
    /** @deprecated Import `MonacoDiffEditor` from `@opencroft/client/code`. */
    MonacoDiffEditor,
    /** @deprecated Import `MonacoNamespace` from `@opencroft/client/code`. */
    MonacoNamespace,
  } from '@opencroft/client/code'
  export {
    /** @deprecated Import `CodeBlock` from `@opencroft/client/code`. */
    CodeBlock,
    /** @deprecated Import `CodeBlockEditor` from `@opencroft/client/code`. */
    CodeBlockEditor,
    /** @deprecated Import `CodeEditor` from `@opencroft/client/code`. */
    CodeEditor,
  } from '@opencroft/client/code'
  export type {
    /** @deprecated Import `DockerContainerSnapshot` from `@opencroft/client/docker`. */
    DockerContainerSnapshot,
  } from '@opencroft/client/docker'
  export type {
    /** @deprecated Import `ExtensionDeclaration` from `@opencroft/client/extension`. */
    ExtensionDeclaration,
    /** @deprecated Import `ExtensionDeclarationManifest` from `@opencroft/client/extension`. */
    ExtensionDeclarationManifest,
    /** @deprecated Import `ProvidedPoints` from `@opencroft/client/extension`. */
    ProvidedPoints,
    /** @deprecated Import `RightSidebarPanel` from `@opencroft/client/extension`. */
    RightSidebarPanel,
    /** @deprecated Import `SettingsPageDefinition` from `@opencroft/client/extension`. */
    SettingsPageDefinition,
  } from '@opencroft/client/extension'
  export {
    /** @deprecated Import `FileBrowser` from `@opencroft/client/files`. */
    FileBrowser,
    /** @deprecated Import `FileManagerProvider` from `@opencroft/client/files`. */
    FileManagerProvider,
  } from '@opencroft/client/files'
  export type {
    /** @deprecated Import `GraphRefDescription` from `@opencroft/client/graph`. */
    GraphRefDescription,
    /** @deprecated Import `NodeRefProps` from `@opencroft/client/graph`. */
    NodeRefProps,
  } from '@opencroft/client/graph'
  export {
    /** @deprecated Import `NodeRef` from `@opencroft/client/graph`. */
    NodeRef,
  } from '@opencroft/client/graph'
  export type {
    /** @deprecated Import `MarkdownDiffViewProps` from `@opencroft/client/markdown`. */
    MarkdownDiffViewProps,
    /** @deprecated Import `MarkdownEditorOwnDocument` from `@opencroft/client/markdown`. */
    MarkdownEditorOwnDocument,
    /** @deprecated Import `MarkdownEditorProps` from `@opencroft/client/markdown`. */
    MarkdownEditorProps,
    /** @deprecated Import `MarkdownEditorSharedDocument` from `@opencroft/client/markdown`. */
    MarkdownEditorSharedDocument,
    /** @deprecated Import `MarkdownEditorSurfaceProps` from `@opencroft/client/markdown`. */
    MarkdownEditorSurfaceProps,
    /** @deprecated Import `MarkdownEditorToolbarGroup` from `@opencroft/client/markdown`. */
    MarkdownEditorToolbarGroup,
    /** @deprecated Import `MarkdownProps` from `@opencroft/client/markdown`. */
    MarkdownProps,
    /** @deprecated Import `MarkdownReference` from `@opencroft/client/markdown`. */
    MarkdownReference,
    /** @deprecated Import `MarkdownReferenceMenuItem` from `@opencroft/client/markdown`. */
    MarkdownReferenceMenuItem,
    /** @deprecated Import `MarkdownReferenceTone` from `@opencroft/client/markdown`. */
    MarkdownReferenceTone,
    /** @deprecated Import `MarkdownResolver` from `@opencroft/client/markdown`. */
    MarkdownResolver,
    /** @deprecated Import `MermaidDiagramProps` from `@opencroft/client/markdown`. */
    MermaidDiagramProps,
  } from '@opencroft/client/markdown'
  export {
    /** @deprecated Import `Markdown` from `@opencroft/client/markdown`. */
    Markdown,
    /** @deprecated Import `MarkdownDiffView` from `@opencroft/client/markdown`. */
    MarkdownDiffView,
    /** @deprecated Import `MarkdownEditor` from `@opencroft/client/markdown`. */
    MarkdownEditor,
    /** @deprecated Import `MermaidDiagram` from `@opencroft/client/markdown`. */
    MermaidDiagram,
    /** @deprecated Import `markdownDirectiveBlocks` from `@opencroft/client/markdown`. */
    markdownDirectiveBlocks,
  } from '@opencroft/client/markdown'
  export type {
    /** @deprecated Import `NamedValue` from `@opencroft/client/secrets`. */
    NamedValue,
    /** @deprecated Import `SecretSelectorProps` from `@opencroft/client/secrets`. */
    SecretSelectorProps,
    /** @deprecated Import `SecretValueFieldProps` from `@opencroft/client/secrets`. */
    SecretValueFieldProps,
    /** @deprecated Import `SecretValueTableProps` from `@opencroft/client/secrets`. */
    SecretValueTableProps,
  } from '@opencroft/client/secrets'
  export {
    /** @deprecated Import `SecretSelector` from `@opencroft/client/secrets`. */
    SecretSelector,
  } from '@opencroft/client/secrets'
  export type {
    /** @deprecated Import `ExtensionStorage` from `@opencroft/client/storage`. */
    ExtensionStorage,
  } from '@opencroft/client/storage'
  export type {
    /** @deprecated Import `Stream` from `@opencroft/client/streams`. */
    Stream,
    /** @deprecated Import `TextChunk` from `@opencroft/client/streams`. */
    TextChunk,
  } from '@opencroft/client/streams'
  export type {
    /** @deprecated Import `TerminalConfig` from `@opencroft/client/terminal`. */
    TerminalConfig,
    /** @deprecated Import `TerminalListProps` from `@opencroft/client/terminal`. */
    TerminalListProps,
    /** @deprecated Import `TerminalProps` from `@opencroft/client/terminal`. */
    TerminalProps,
    /** @deprecated Import `TerminalRefProps` from `@opencroft/client/terminal`. */
    TerminalRefProps,
    /** @deprecated Import `TerminalSelectorProps` from `@opencroft/client/terminal`. */
    TerminalSelectorProps,
    /** @deprecated Import `TerminalSourceOwner` from `@opencroft/client/terminal`. */
    TerminalSourceOwner,
    /** @deprecated Import `TerminalStatus` from `@opencroft/client/terminal`. */
    TerminalStatus,
  } from '@opencroft/client/terminal'
  export {
    /** @deprecated Import `Terminal` from `@opencroft/client/terminal`. */
    Terminal,
    /** @deprecated Use `Terminal` from `@opencroft/client/terminal`. */
    Terminal as InspectorTerminalBody,
    /** @deprecated Import `TerminalList` from `@opencroft/client/terminal`. */
    TerminalList,
    /** @deprecated Import `TerminalRef` from `@opencroft/client/terminal`. */
    TerminalRef,
    /** @deprecated Import `TerminalSelector` from `@opencroft/client/terminal`. */
    TerminalSelector,
  } from '@opencroft/client/terminal'
  export type {
    /** @deprecated Import `AccountCardProps` from `@opencroft/client/ui`. */
    AccountCardProps,
    /** @deprecated Import `AdaptivePopupProps` from `@opencroft/client/ui`. */
    AdaptivePopupProps,
    /** @deprecated Import `AgentAvatarSize` from `@opencroft/client/ui`. */
    AgentAvatarSize,
    /** @deprecated Import `AgentJobRef` from `@opencroft/client/ui`. */
    AgentJobRef,
    /** @deprecated Import `AgentRef` from `@opencroft/client/ui`. */
    AgentRef,
    /** @deprecated Import `AgentSessionGroup` from `@opencroft/client/ui`. */
    AgentSessionGroup,
    /** @deprecated Import `AgentSessionListProps` from `@opencroft/client/ui`. */
    AgentSessionListProps,
    /** @deprecated Import `AgentSessionSummary` from `@opencroft/client/ui`. */
    AgentSessionSummary,
    /** @deprecated Import `AlignItems` from `@opencroft/client/ui`. */
    AlignItems,
    /** @deprecated Import `ApiToken` from `@opencroft/client/ui`. */
    ApiToken,
    /** @deprecated Import `ApiTokenCreateFormProps` from `@opencroft/client/ui`. */
    ApiTokenCreateFormProps,
    /** @deprecated Import `ApiTokenExpiryOption` from `@opencroft/client/ui`. */
    ApiTokenExpiryOption,
    /** @deprecated Import `ApiTokenListProps` from `@opencroft/client/ui`. */
    ApiTokenListProps,
    /** @deprecated Import `ApiTokenRevealProps` from `@opencroft/client/ui`. */
    ApiTokenRevealProps,
    /** @deprecated Import `CallActionActionOption` from `@opencroft/client/ui`. */
    CallActionActionOption,
    /** @deprecated Import `CallActionAppOption` from `@opencroft/client/ui`. */
    CallActionAppOption,
    /** @deprecated Import `CallActionNodeOption` from `@opencroft/client/ui`. */
    CallActionNodeOption,
    /** @deprecated Import `CallActionTargetProps` from `@opencroft/client/ui`. */
    CallActionTargetProps,
    /** @deprecated Import `CallActionTargetValue` from `@opencroft/client/ui`. */
    CallActionTargetValue,
    /** @deprecated Import `CarouselApi` from `@opencroft/client/ui`. */
    CarouselApi,
    /** @deprecated Import `ChartConfig` from `@opencroft/client/ui`. */
    ChartConfig,
    /** @deprecated Import `ChatInputProps` from `@opencroft/client/ui`. */
    ChatInputProps,
    /** @deprecated Import `ChatMessageProps` from `@opencroft/client/ui`. */
    ChatMessageProps,
    /** @deprecated Import `ControlledInputProps` from `@opencroft/client/ui`. */
    ControlledInputProps,
    /** @deprecated Import `ControlledTextareaProps` from `@opencroft/client/ui`. */
    ControlledTextareaProps,
    /** @deprecated Import `EnvironmentTableProps` from `@opencroft/client/ui`. */
    EnvironmentTableProps,
    /** @deprecated Import `EnvironmentValue` from `@opencroft/client/ui`. */
    EnvironmentValue,
    /** @deprecated Import `EnvironmentVariable` from `@opencroft/client/ui`. */
    EnvironmentVariable,
    /** @deprecated Import `ExampleFrameProps` from `@opencroft/client/ui`. */
    ExampleFrameProps,
    /** @deprecated Import `FieldHintProps` from `@opencroft/client/ui`. */
    FieldHintProps,
    /** @deprecated Import `FixedAreaProps` from `@opencroft/client/ui`. */
    FixedAreaProps,
    /** @deprecated Import `FlexDirection` from `@opencroft/client/ui`. */
    FlexDirection,
    /** @deprecated Import `FlexProps` from `@opencroft/client/ui`. */
    FlexProps,
    /** @deprecated Import `GridProps` from `@opencroft/client/ui`. */
    GridProps,
    /** @deprecated Import `GridSize` from `@opencroft/client/ui`. */
    GridSize,
    /** @deprecated Import `GridSizeSwitcherProps` from `@opencroft/client/ui`. */
    GridSizeSwitcherProps,
    /** @deprecated Import `ImageAreaProps` from `@opencroft/client/ui`. */
    ImageAreaProps,
    /** @deprecated Import `ImageComparisonProps` from `@opencroft/client/ui`. */
    ImageComparisonProps,
    /** @deprecated Import `ImageComparisonSide` from `@opencroft/client/ui`. */
    ImageComparisonSide,
    /** @deprecated Import `JustifyContent` from `@opencroft/client/ui`. */
    JustifyContent,
    /** @deprecated Import `MenuLayoutProps` from `@opencroft/client/ui`. */
    MenuLayoutProps,
    /** @deprecated Import `MenuWidth` from `@opencroft/client/ui`. */
    MenuWidth,
    /** @deprecated Import `NamedSectionProps` from `@opencroft/client/ui`. */
    NamedSectionProps,
    /** @deprecated Import `NodeRow` from `@opencroft/client/ui`. */
    NodeRow,
    /** @deprecated Import `NodeRowListProps` from `@opencroft/client/ui`. */
    NodeRowListProps,
    /** @deprecated Import `NodeRowSlot` from `@opencroft/client/ui`. */
    NodeRowSlot,
    /** @deprecated Import `NodeValue` from `@opencroft/client/ui`. */
    NodeValue,
    /** @deprecated Import `NodeValueInputProps` from `@opencroft/client/ui`. */
    NodeValueInputProps,
    /** @deprecated Import `NodeValueKind` from `@opencroft/client/ui`. */
    NodeValueKind,
    /** @deprecated Import `NodeValueOption` from `@opencroft/client/ui`. */
    NodeValueOption,
    /** @deprecated Import `PageProps` from `@opencroft/client/ui`. */
    PageProps,
    /** @deprecated Import `PopupContentProps` from `@opencroft/client/ui`. */
    PopupContentProps,
    /** @deprecated Import `PopupFooterProps` from `@opencroft/client/ui`. */
    PopupFooterProps,
    /** @deprecated Import `PopupHeaderProps` from `@opencroft/client/ui`. */
    PopupHeaderProps,
    /** @deprecated Import `PopupRecyclingContentProps` from `@opencroft/client/ui`. */
    PopupRecyclingContentProps,
    /** @deprecated Import `PopupSubHeaderProps` from `@opencroft/client/ui`. */
    PopupSubHeaderProps,
    /** @deprecated Import `RunHistoryEntry` from `@opencroft/client/ui`. */
    RunHistoryEntry,
    /** @deprecated Import `RunStatus` from `@opencroft/client/ui`. */
    RunStatus,
    /** @deprecated Import `SaveFileCollision` from `@opencroft/client/ui`. */
    SaveFileCollision,
    /** @deprecated Import `SaveFileFieldsProps` from `@opencroft/client/ui`. */
    SaveFileFieldsProps,
    /** @deprecated Import `SaveFileFolderListing` from `@opencroft/client/ui`. */
    SaveFileFolderListing,
    /** @deprecated Import `SaveFilePreview` from `@opencroft/client/ui`. */
    SaveFilePreview,
    /** @deprecated Import `SaveFileToken` from `@opencroft/client/ui`. */
    SaveFileToken,
    /** @deprecated Import `ScheduleMode` from `@opencroft/client/ui`. */
    ScheduleMode,
    /** @deprecated Import `ScheduleRule` from `@opencroft/client/ui`. */
    ScheduleRule,
    /** @deprecated Import `SchedulesProps` from `@opencroft/client/ui`. */
    SchedulesProps,
    /** @deprecated Import `ScheduleUnit` from `@opencroft/client/ui`. */
    ScheduleUnit,
    /** @deprecated Import `ScrollAreaScrollbars` from `@opencroft/client/ui`. */
    ScrollAreaScrollbars,
    /** @deprecated Import `SecretInputProps` from `@opencroft/client/ui`. */
    SecretInputProps,
    /** @deprecated Import `SimpleSchedule` from `@opencroft/client/ui`. */
    SimpleSchedule,
    /** @deprecated Import `StatusIndicatorProps` from `@opencroft/client/ui`. */
    StatusIndicatorProps,
    /** @deprecated Import `StatusVariant` from `@opencroft/client/ui`. */
    StatusVariant,
    /** @deprecated Import `TypingDotsProps` from `@opencroft/client/ui`. */
    TypingDotsProps,
    /** @deprecated Import `UpcomingRun` from `@opencroft/client/ui`. */
    UpcomingRun,
  } from '@opencroft/client/ui'
  export {
    /** @deprecated Import `Accordion` from `@opencroft/client/ui`. */
    Accordion,
    /** @deprecated Import `AccordionContent` from `@opencroft/client/ui`. */
    AccordionContent,
    /** @deprecated Import `AccordionItem` from `@opencroft/client/ui`. */
    AccordionItem,
    /** @deprecated Import `AccordionTrigger` from `@opencroft/client/ui`. */
    AccordionTrigger,
    /** @deprecated Import `AccountCard` from `@opencroft/client/ui`. */
    AccountCard,
    /** @deprecated Import `AdaptivePopup` from `@opencroft/client/ui`. */
    AdaptivePopup,
    /** @deprecated Import `AgentAvatar` from `@opencroft/client/ui`. */
    AgentAvatar,
    /** @deprecated Import `AgentSessionList` from `@opencroft/client/ui`. */
    AgentSessionList,
    /** @deprecated Import `Alert` from `@opencroft/client/ui`. */
    Alert,
    /** @deprecated Import `AlertAction` from `@opencroft/client/ui`. */
    AlertAction,
    /** @deprecated Import `AlertDescription` from `@opencroft/client/ui`. */
    AlertDescription,
    /** @deprecated Import `AlertDialog` from `@opencroft/client/ui`. */
    AlertDialog,
    /** @deprecated Import `AlertDialogAction` from `@opencroft/client/ui`. */
    AlertDialogAction,
    /** @deprecated Import `AlertDialogBody` from `@opencroft/client/ui`. */
    AlertDialogBody,
    /** @deprecated Import `AlertDialogCancel` from `@opencroft/client/ui`. */
    AlertDialogCancel,
    /** @deprecated Import `AlertDialogContent` from `@opencroft/client/ui`. */
    AlertDialogContent,
    /** @deprecated Import `AlertDialogDescription` from `@opencroft/client/ui`. */
    AlertDialogDescription,
    /** @deprecated Import `AlertDialogFooter` from `@opencroft/client/ui`. */
    AlertDialogFooter,
    /** @deprecated Import `AlertDialogHeader` from `@opencroft/client/ui`. */
    AlertDialogHeader,
    /** @deprecated Import `AlertDialogMedia` from `@opencroft/client/ui`. */
    AlertDialogMedia,
    /** @deprecated Import `AlertDialogOverlay` from `@opencroft/client/ui`. */
    AlertDialogOverlay,
    /** @deprecated Import `AlertDialogPortal` from `@opencroft/client/ui`. */
    AlertDialogPortal,
    /** @deprecated Import `AlertDialogTitle` from `@opencroft/client/ui`. */
    AlertDialogTitle,
    /** @deprecated Import `AlertDialogTrigger` from `@opencroft/client/ui`. */
    AlertDialogTrigger,
    /** @deprecated Import `AlertTitle` from `@opencroft/client/ui`. */
    AlertTitle,
    /** @deprecated Import `ApiTokenCreateForm` from `@opencroft/client/ui`. */
    ApiTokenCreateForm,
    /** @deprecated Import `ApiTokenList` from `@opencroft/client/ui`. */
    ApiTokenList,
    /** @deprecated Import `ApiTokenReveal` from `@opencroft/client/ui`. */
    ApiTokenReveal,
    /** @deprecated Import `AspectRatio` from `@opencroft/client/ui`. */
    AspectRatio,
    /** @deprecated Import `Avatar` from `@opencroft/client/ui`. */
    Avatar,
    /** @deprecated Import `AvatarBadge` from `@opencroft/client/ui`. */
    AvatarBadge,
    /** @deprecated Import `AvatarFallback` from `@opencroft/client/ui`. */
    AvatarFallback,
    /** @deprecated Import `AvatarGroup` from `@opencroft/client/ui`. */
    AvatarGroup,
    /** @deprecated Import `AvatarGroupCount` from `@opencroft/client/ui`. */
    AvatarGroupCount,
    /** @deprecated Import `AvatarImage` from `@opencroft/client/ui`. */
    AvatarImage,
    /** @deprecated Import `Badge` from `@opencroft/client/ui`. */
    Badge,
    /** @deprecated Import `Breadcrumb` from `@opencroft/client/ui`. */
    Breadcrumb,
    /** @deprecated Import `BreadcrumbEllipsis` from `@opencroft/client/ui`. */
    BreadcrumbEllipsis,
    /** @deprecated Import `BreadcrumbItem` from `@opencroft/client/ui`. */
    BreadcrumbItem,
    /** @deprecated Import `BreadcrumbLink` from `@opencroft/client/ui`. */
    BreadcrumbLink,
    /** @deprecated Import `BreadcrumbList` from `@opencroft/client/ui`. */
    BreadcrumbList,
    /** @deprecated Import `BreadcrumbPage` from `@opencroft/client/ui`. */
    BreadcrumbPage,
    /** @deprecated Import `BreadcrumbSeparator` from `@opencroft/client/ui`. */
    BreadcrumbSeparator,
    /** @deprecated Import `Button` from `@opencroft/client/ui`. */
    Button,
    /** @deprecated Import `ButtonGroup` from `@opencroft/client/ui`. */
    ButtonGroup,
    /** @deprecated Import `ButtonGroupSeparator` from `@opencroft/client/ui`. */
    ButtonGroupSeparator,
    /** @deprecated Import `ButtonGroupText` from `@opencroft/client/ui`. */
    ButtonGroupText,
    /** @deprecated Import `badgeVariants` from `@opencroft/client/ui`. */
    badgeVariants,
    /** @deprecated Import `buttonGroupVariants` from `@opencroft/client/ui`. */
    buttonGroupVariants,
    /** @deprecated Import `buttonVariants` from `@opencroft/client/ui`. */
    buttonVariants,
    /** @deprecated Import `Calendar` from `@opencroft/client/ui`. */
    Calendar,
    /** @deprecated Import `CalendarDayButton` from `@opencroft/client/ui`. */
    CalendarDayButton,
    /** @deprecated Import `CallActionTarget` from `@opencroft/client/ui`. */
    CallActionTarget,
    /** @deprecated Import `Card` from `@opencroft/client/ui`. */
    Card,
    /** @deprecated Import `CardAction` from `@opencroft/client/ui`. */
    CardAction,
    /** @deprecated Import `CardContent` from `@opencroft/client/ui`. */
    CardContent,
    /** @deprecated Import `CardDescription` from `@opencroft/client/ui`. */
    CardDescription,
    /** @deprecated Import `CardFooter` from `@opencroft/client/ui`. */
    CardFooter,
    /** @deprecated Import `CardHeader` from `@opencroft/client/ui`. */
    CardHeader,
    /** @deprecated Import `CardTitle` from `@opencroft/client/ui`. */
    CardTitle,
    /** @deprecated Import `Carousel` from `@opencroft/client/ui`. */
    Carousel,
    /** @deprecated Import `CarouselContent` from `@opencroft/client/ui`. */
    CarouselContent,
    /** @deprecated Import `CarouselItem` from `@opencroft/client/ui`. */
    CarouselItem,
    /** @deprecated Import `CarouselNext` from `@opencroft/client/ui`. */
    CarouselNext,
    /** @deprecated Import `CarouselPrevious` from `@opencroft/client/ui`. */
    CarouselPrevious,
    /** @deprecated Import `ChartContainer` from `@opencroft/client/ui`. */
    ChartContainer,
    /** @deprecated Import `ChartLegend` from `@opencroft/client/ui`. */
    ChartLegend,
    /** @deprecated Import `ChartLegendContent` from `@opencroft/client/ui`. */
    ChartLegendContent,
    /** @deprecated Import `ChartStyle` from `@opencroft/client/ui`. */
    ChartStyle,
    /** @deprecated Import `ChartTooltip` from `@opencroft/client/ui`. */
    ChartTooltip,
    /** @deprecated Import `ChartTooltipContent` from `@opencroft/client/ui`. */
    ChartTooltipContent,
    /** @deprecated Import `ChatInput` from `@opencroft/client/ui`. */
    ChatInput,
    /** @deprecated Import `ChatMessage` from `@opencroft/client/ui`. */
    ChatMessage,
    /** @deprecated Import `Checkbox` from `@opencroft/client/ui`. */
    Checkbox,
    /** @deprecated Import `Collapsible` from `@opencroft/client/ui`. */
    Collapsible,
    /** @deprecated Import `CollapsibleContent` from `@opencroft/client/ui`. */
    CollapsibleContent,
    /** @deprecated Import `CollapsibleTrigger` from `@opencroft/client/ui`. */
    CollapsibleTrigger,
    /** @deprecated Import `Combobox` from `@opencroft/client/ui`. */
    Combobox,
    /** @deprecated Import `ComboboxChip` from `@opencroft/client/ui`. */
    ComboboxChip,
    /** @deprecated Import `ComboboxChips` from `@opencroft/client/ui`. */
    ComboboxChips,
    /** @deprecated Import `ComboboxChipsInput` from `@opencroft/client/ui`. */
    ComboboxChipsInput,
    /** @deprecated Import `ComboboxCollection` from `@opencroft/client/ui`. */
    ComboboxCollection,
    /** @deprecated Import `ComboboxContent` from `@opencroft/client/ui`. */
    ComboboxContent,
    /** @deprecated Import `ComboboxEmpty` from `@opencroft/client/ui`. */
    ComboboxEmpty,
    /** @deprecated Import `ComboboxGroup` from `@opencroft/client/ui`. */
    ComboboxGroup,
    /** @deprecated Import `ComboboxInput` from `@opencroft/client/ui`. */
    ComboboxInput,
    /** @deprecated Import `ComboboxItem` from `@opencroft/client/ui`. */
    ComboboxItem,
    /** @deprecated Import `ComboboxLabel` from `@opencroft/client/ui`. */
    ComboboxLabel,
    /** @deprecated Import `ComboboxList` from `@opencroft/client/ui`. */
    ComboboxList,
    /** @deprecated Import `ComboboxSeparator` from `@opencroft/client/ui`. */
    ComboboxSeparator,
    /** @deprecated Import `ComboboxTrigger` from `@opencroft/client/ui`. */
    ComboboxTrigger,
    /** @deprecated Import `ComboboxValue` from `@opencroft/client/ui`. */
    ComboboxValue,
    /** @deprecated Import `Command` from `@opencroft/client/ui`. */
    Command,
    /** @deprecated Import `CommandDialog` from `@opencroft/client/ui`. */
    CommandDialog,
    /** @deprecated Import `CommandEmpty` from `@opencroft/client/ui`. */
    CommandEmpty,
    /** @deprecated Import `CommandGroup` from `@opencroft/client/ui`. */
    CommandGroup,
    /** @deprecated Import `CommandInput` from `@opencroft/client/ui`. */
    CommandInput,
    /** @deprecated Import `CommandItem` from `@opencroft/client/ui`. */
    CommandItem,
    /** @deprecated Import `CommandList` from `@opencroft/client/ui`. */
    CommandList,
    /** @deprecated Import `CommandSeparator` from `@opencroft/client/ui`. */
    CommandSeparator,
    /** @deprecated Import `CommandShortcut` from `@opencroft/client/ui`. */
    CommandShortcut,
    /** @deprecated Import `ContextMenu` from `@opencroft/client/ui`. */
    ContextMenu,
    /** @deprecated Import `ContextMenuCheckboxItem` from `@opencroft/client/ui`. */
    ContextMenuCheckboxItem,
    /** @deprecated Import `ContextMenuContent` from `@opencroft/client/ui`. */
    ContextMenuContent,
    /** @deprecated Import `ContextMenuGroup` from `@opencroft/client/ui`. */
    ContextMenuGroup,
    /** @deprecated Import `ContextMenuItem` from `@opencroft/client/ui`. */
    ContextMenuItem,
    /** @deprecated Import `ContextMenuLabel` from `@opencroft/client/ui`. */
    ContextMenuLabel,
    /** @deprecated Import `ContextMenuPortal` from `@opencroft/client/ui`. */
    ContextMenuPortal,
    /** @deprecated Import `ContextMenuRadioGroup` from `@opencroft/client/ui`. */
    ContextMenuRadioGroup,
    /** @deprecated Import `ContextMenuRadioItem` from `@opencroft/client/ui`. */
    ContextMenuRadioItem,
    /** @deprecated Import `ContextMenuSeparator` from `@opencroft/client/ui`. */
    ContextMenuSeparator,
    /** @deprecated Import `ContextMenuShortcut` from `@opencroft/client/ui`. */
    ContextMenuShortcut,
    /** @deprecated Import `ContextMenuSub` from `@opencroft/client/ui`. */
    ContextMenuSub,
    /** @deprecated Import `ContextMenuSubContent` from `@opencroft/client/ui`. */
    ContextMenuSubContent,
    /** @deprecated Import `ContextMenuSubTrigger` from `@opencroft/client/ui`. */
    ContextMenuSubTrigger,
    /** @deprecated Import `ContextMenuTrigger` from `@opencroft/client/ui`. */
    ContextMenuTrigger,
    /** @deprecated Import `ControlledInput` from `@opencroft/client/ui`. */
    ControlledInput,
    /** @deprecated Import `ControlledTextarea` from `@opencroft/client/ui`. */
    ControlledTextarea,
    /** @deprecated Import `concealedTextClass` from `@opencroft/client/ui`. */
    concealedTextClass,
    /** @deprecated Import `createIFrameRoute` from `@opencroft/client/ui`. */
    createIFrameRoute,
    /** @deprecated Import `Dialog` from `@opencroft/client/ui`. */
    Dialog,
    /** @deprecated Import `DialogBody` from `@opencroft/client/ui`. */
    DialogBody,
    /** @deprecated Import `DialogClose` from `@opencroft/client/ui`. */
    DialogClose,
    /** @deprecated Import `DialogContent` from `@opencroft/client/ui`. */
    DialogContent,
    /** @deprecated Import `DialogDescription` from `@opencroft/client/ui`. */
    DialogDescription,
    /** @deprecated Import `DialogFooter` from `@opencroft/client/ui`. */
    DialogFooter,
    /** @deprecated Import `DialogHeader` from `@opencroft/client/ui`. */
    DialogHeader,
    /** @deprecated Import `DialogOverlay` from `@opencroft/client/ui`. */
    DialogOverlay,
    /** @deprecated Import `DialogPortal` from `@opencroft/client/ui`. */
    DialogPortal,
    /** @deprecated Import `DialogTitle` from `@opencroft/client/ui`. */
    DialogTitle,
    /** @deprecated Import `DialogTrigger` from `@opencroft/client/ui`. */
    DialogTrigger,
    /** @deprecated Import `DirectionProvider` from `@opencroft/client/ui`. */
    DirectionProvider,
    /** @deprecated Import `Drawer` from `@opencroft/client/ui`. */
    Drawer,
    /** @deprecated Import `DrawerClose` from `@opencroft/client/ui`. */
    DrawerClose,
    /** @deprecated Import `DrawerContent` from `@opencroft/client/ui`. */
    DrawerContent,
    /** @deprecated Import `DrawerDescription` from `@opencroft/client/ui`. */
    DrawerDescription,
    /** @deprecated Import `DrawerFooter` from `@opencroft/client/ui`. */
    DrawerFooter,
    /** @deprecated Import `DrawerHeader` from `@opencroft/client/ui`. */
    DrawerHeader,
    /** @deprecated Import `DrawerOverlay` from `@opencroft/client/ui`. */
    DrawerOverlay,
    /** @deprecated Import `DrawerPortal` from `@opencroft/client/ui`. */
    DrawerPortal,
    /** @deprecated Import `DrawerSwipeHandle` from `@opencroft/client/ui`. */
    DrawerSwipeHandle,
    /** @deprecated Import `DrawerTitle` from `@opencroft/client/ui`. */
    DrawerTitle,
    /** @deprecated Import `DrawerTrigger` from `@opencroft/client/ui`. */
    DrawerTrigger,
    /** @deprecated Import `DropdownMenu` from `@opencroft/client/ui`. */
    DropdownMenu,
    /** @deprecated Import `DropdownMenuCheckboxItem` from `@opencroft/client/ui`. */
    DropdownMenuCheckboxItem,
    /** @deprecated Import `DropdownMenuContent` from `@opencroft/client/ui`. */
    DropdownMenuContent,
    /** @deprecated Import `DropdownMenuGroup` from `@opencroft/client/ui`. */
    DropdownMenuGroup,
    /** @deprecated Import `DropdownMenuItem` from `@opencroft/client/ui`. */
    DropdownMenuItem,
    /** @deprecated Import `DropdownMenuLabel` from `@opencroft/client/ui`. */
    DropdownMenuLabel,
    /** @deprecated Import `DropdownMenuPortal` from `@opencroft/client/ui`. */
    DropdownMenuPortal,
    /** @deprecated Import `DropdownMenuRadioGroup` from `@opencroft/client/ui`. */
    DropdownMenuRadioGroup,
    /** @deprecated Import `DropdownMenuRadioItem` from `@opencroft/client/ui`. */
    DropdownMenuRadioItem,
    /** @deprecated Import `DropdownMenuSeparator` from `@opencroft/client/ui`. */
    DropdownMenuSeparator,
    /** @deprecated Import `DropdownMenuShortcut` from `@opencroft/client/ui`. */
    DropdownMenuShortcut,
    /** @deprecated Import `DropdownMenuSub` from `@opencroft/client/ui`. */
    DropdownMenuSub,
    /** @deprecated Import `DropdownMenuSubContent` from `@opencroft/client/ui`. */
    DropdownMenuSubContent,
    /** @deprecated Import `DropdownMenuSubTrigger` from `@opencroft/client/ui`. */
    DropdownMenuSubTrigger,
    /** @deprecated Import `DropdownMenuTrigger` from `@opencroft/client/ui`. */
    DropdownMenuTrigger,
    /** @deprecated Import `Empty` from `@opencroft/client/ui`. */
    Empty,
    /** @deprecated Import `EmptyContent` from `@opencroft/client/ui`. */
    EmptyContent,
    /** @deprecated Import `EmptyDescription` from `@opencroft/client/ui`. */
    EmptyDescription,
    /** @deprecated Import `EmptyHeader` from `@opencroft/client/ui`. */
    EmptyHeader,
    /** @deprecated Import `EmptyMedia` from `@opencroft/client/ui`. */
    EmptyMedia,
    /** @deprecated Import `EmptyTitle` from `@opencroft/client/ui`. */
    EmptyTitle,
    /** @deprecated Import `EnvironmentTable` from `@opencroft/client/ui`. */
    EnvironmentTable,
    /** @deprecated Import `ExampleFrame` from `@opencroft/client/ui`. */
    ExampleFrame,
    /** @deprecated Import `Field` from `@opencroft/client/ui`. */
    Field,
    /** @deprecated Import `FieldContent` from `@opencroft/client/ui`. */
    FieldContent,
    /** @deprecated Import `FieldDescription` from `@opencroft/client/ui`. */
    FieldDescription,
    /** @deprecated Import `FieldError` from `@opencroft/client/ui`. */
    FieldError,
    /** @deprecated Import `FieldGroup` from `@opencroft/client/ui`. */
    FieldGroup,
    /** @deprecated Import `FieldHint` from `@opencroft/client/ui`. */
    FieldHint,
    /** @deprecated Import `FieldLabel` from `@opencroft/client/ui`. */
    FieldLabel,
    /** @deprecated Import `FieldLegend` from `@opencroft/client/ui`. */
    FieldLegend,
    /** @deprecated Import `FieldSeparator` from `@opencroft/client/ui`. */
    FieldSeparator,
    /** @deprecated Import `FieldSet` from `@opencroft/client/ui`. */
    FieldSet,
    /** @deprecated Import `FieldTitle` from `@opencroft/client/ui`. */
    FieldTitle,
    /** @deprecated Import `FixedArea` from `@opencroft/client/ui`. */
    FixedArea,
    /** @deprecated Import `Flex` from `@opencroft/client/ui`. */
    Flex,
    /** @deprecated Import `Grid` from `@opencroft/client/ui`. */
    Grid,
    /** @deprecated Import `GridSizeSwitcher` from `@opencroft/client/ui`. */
    GridSizeSwitcher,
    /** @deprecated Import `gridSizeClasses` from `@opencroft/client/ui`. */
    gridSizeClasses,
    /** @deprecated Import `HoverCard` from `@opencroft/client/ui`. */
    HoverCard,
    /** @deprecated Import `HoverCardContent` from `@opencroft/client/ui`. */
    HoverCardContent,
    /** @deprecated Import `HoverCardTrigger` from `@opencroft/client/ui`. */
    HoverCardTrigger,
    /** @deprecated Import `humanizeCron` from `@opencroft/client/ui`. */
    humanizeCron,
    /** @deprecated Import `IFrame` from `@opencroft/client/ui`. */
    IFrame,
    /** @deprecated Import `ImageArea` from `@opencroft/client/ui`. */
    ImageArea,
    /** @deprecated Import `ImageComparison` from `@opencroft/client/ui`. */
    ImageComparison,
    /** @deprecated Import `Input` from `@opencroft/client/ui`. */
    Input,
    /** @deprecated Import `InputGroup` from `@opencroft/client/ui`. */
    InputGroup,
    /** @deprecated Import `InputGroupAddon` from `@opencroft/client/ui`. */
    InputGroupAddon,
    /** @deprecated Import `InputGroupButton` from `@opencroft/client/ui`. */
    InputGroupButton,
    /** @deprecated Import `InputGroupInput` from `@opencroft/client/ui`. */
    InputGroupInput,
    /** @deprecated Import `InputGroupText` from `@opencroft/client/ui`. */
    InputGroupText,
    /** @deprecated Import `InputGroupTextarea` from `@opencroft/client/ui`. */
    InputGroupTextarea,
    /** @deprecated Import `InputOTP` from `@opencroft/client/ui`. */
    InputOTP,
    /** @deprecated Import `InputOTPGroup` from `@opencroft/client/ui`. */
    InputOTPGroup,
    /** @deprecated Import `InputOTPSeparator` from `@opencroft/client/ui`. */
    InputOTPSeparator,
    /** @deprecated Import `InputOTPSlot` from `@opencroft/client/ui`. */
    InputOTPSlot,
    /** @deprecated Import `Item` from `@opencroft/client/ui`. */
    Item,
    /** @deprecated Import `ItemActions` from `@opencroft/client/ui`. */
    ItemActions,
    /** @deprecated Import `ItemContent` from `@opencroft/client/ui`. */
    ItemContent,
    /** @deprecated Import `ItemDescription` from `@opencroft/client/ui`. */
    ItemDescription,
    /** @deprecated Import `ItemFooter` from `@opencroft/client/ui`. */
    ItemFooter,
    /** @deprecated Import `ItemGroup` from `@opencroft/client/ui`. */
    ItemGroup,
    /** @deprecated Import `ItemHeader` from `@opencroft/client/ui`. */
    ItemHeader,
    /** @deprecated Import `ItemMedia` from `@opencroft/client/ui`. */
    ItemMedia,
    /** @deprecated Import `ItemSeparator` from `@opencroft/client/ui`. */
    ItemSeparator,
    /** @deprecated Import `ItemTitle` from `@opencroft/client/ui`. */
    ItemTitle,
    /** @deprecated Import `inRowOrder` from `@opencroft/client/ui`. */
    inRowOrder,
    /** @deprecated Import `Kbd` from `@opencroft/client/ui`. */
    Kbd,
    /** @deprecated Import `KbdGroup` from `@opencroft/client/ui`. */
    KbdGroup,
    /** @deprecated Import `Label` from `@opencroft/client/ui`. */
    Label,
    /** @deprecated Import `Menubar` from `@opencroft/client/ui`. */
    Menubar,
    /** @deprecated Import `MenubarCheckboxItem` from `@opencroft/client/ui`. */
    MenubarCheckboxItem,
    /** @deprecated Import `MenubarContent` from `@opencroft/client/ui`. */
    MenubarContent,
    /** @deprecated Import `MenubarGroup` from `@opencroft/client/ui`. */
    MenubarGroup,
    /** @deprecated Import `MenubarItem` from `@opencroft/client/ui`. */
    MenubarItem,
    /** @deprecated Import `MenubarLabel` from `@opencroft/client/ui`. */
    MenubarLabel,
    /** @deprecated Import `MenubarMenu` from `@opencroft/client/ui`. */
    MenubarMenu,
    /** @deprecated Import `MenubarPortal` from `@opencroft/client/ui`. */
    MenubarPortal,
    /** @deprecated Import `MenubarRadioGroup` from `@opencroft/client/ui`. */
    MenubarRadioGroup,
    /** @deprecated Import `MenubarRadioItem` from `@opencroft/client/ui`. */
    MenubarRadioItem,
    /** @deprecated Import `MenubarSeparator` from `@opencroft/client/ui`. */
    MenubarSeparator,
    /** @deprecated Import `MenubarShortcut` from `@opencroft/client/ui`. */
    MenubarShortcut,
    /** @deprecated Import `MenubarSub` from `@opencroft/client/ui`. */
    MenubarSub,
    /** @deprecated Import `MenubarSubContent` from `@opencroft/client/ui`. */
    MenubarSubContent,
    /** @deprecated Import `MenubarSubTrigger` from `@opencroft/client/ui`. */
    MenubarSubTrigger,
    /** @deprecated Import `MenubarTrigger` from `@opencroft/client/ui`. */
    MenubarTrigger,
    /** @deprecated Import `MenuLayout` from `@opencroft/client/ui`. */
    MenuLayout,
    /** @deprecated Import `NamedSection` from `@opencroft/client/ui`. */
    NamedSection,
    /** @deprecated Import `NativeSelect` from `@opencroft/client/ui`. */
    NativeSelect,
    /** @deprecated Import `NativeSelectOptGroup` from `@opencroft/client/ui`. */
    NativeSelectOptGroup,
    /** @deprecated Import `NativeSelectOption` from `@opencroft/client/ui`. */
    NativeSelectOption,
    /** @deprecated Import `NavigationMenu` from `@opencroft/client/ui`. */
    NavigationMenu,
    /** @deprecated Import `NavigationMenuContent` from `@opencroft/client/ui`. */
    NavigationMenuContent,
    /** @deprecated Import `NavigationMenuIndicator` from `@opencroft/client/ui`. */
    NavigationMenuIndicator,
    /** @deprecated Import `NavigationMenuItem` from `@opencroft/client/ui`. */
    NavigationMenuItem,
    /** @deprecated Import `NavigationMenuLink` from `@opencroft/client/ui`. */
    NavigationMenuLink,
    /** @deprecated Import `NavigationMenuList` from `@opencroft/client/ui`. */
    NavigationMenuList,
    /** @deprecated Import `NavigationMenuPositioner` from `@opencroft/client/ui`. */
    NavigationMenuPositioner,
    /** @deprecated Import `NavigationMenuTrigger` from `@opencroft/client/ui`. */
    NavigationMenuTrigger,
    /** @deprecated Import `NodeRowList` from `@opencroft/client/ui`. */
    NodeRowList,
    /** @deprecated Import `NodeValueInput` from `@opencroft/client/ui`. */
    NodeValueInput,
    /** @deprecated Import `navigationMenuTriggerStyle` from `@opencroft/client/ui`. */
    navigationMenuTriggerStyle,
    /** @deprecated Import `Page` from `@opencroft/client/ui`. */
    Page,
    /** @deprecated Import `Pagination` from `@opencroft/client/ui`. */
    Pagination,
    /** @deprecated Import `PaginationContent` from `@opencroft/client/ui`. */
    PaginationContent,
    /** @deprecated Import `PaginationEllipsis` from `@opencroft/client/ui`. */
    PaginationEllipsis,
    /** @deprecated Import `PaginationItem` from `@opencroft/client/ui`. */
    PaginationItem,
    /** @deprecated Import `PaginationLink` from `@opencroft/client/ui`. */
    PaginationLink,
    /** @deprecated Import `PaginationNext` from `@opencroft/client/ui`. */
    PaginationNext,
    /** @deprecated Import `PaginationPrevious` from `@opencroft/client/ui`. */
    PaginationPrevious,
    /** @deprecated Import `Popover` from `@opencroft/client/ui`. */
    Popover,
    /** @deprecated Import `PopoverContent` from `@opencroft/client/ui`. */
    PopoverContent,
    /** @deprecated Import `PopoverDescription` from `@opencroft/client/ui`. */
    PopoverDescription,
    /** @deprecated Import `PopoverHeader` from `@opencroft/client/ui`. */
    PopoverHeader,
    /** @deprecated Import `PopoverTitle` from `@opencroft/client/ui`. */
    PopoverTitle,
    /** @deprecated Import `PopoverTrigger` from `@opencroft/client/ui`. */
    PopoverTrigger,
    /** @deprecated Import `PopupContent` from `@opencroft/client/ui`. */
    PopupContent,
    /** @deprecated Import `PopupFooter` from `@opencroft/client/ui`. */
    PopupFooter,
    /** @deprecated Import `PopupHeader` from `@opencroft/client/ui`. */
    PopupHeader,
    /** @deprecated Import `PopupRecyclingContent` from `@opencroft/client/ui`. */
    PopupRecyclingContent,
    /** @deprecated Import `PopupSubHeader` from `@opencroft/client/ui`. */
    PopupSubHeader,
    /** @deprecated Import `Progress` from `@opencroft/client/ui`. */
    Progress,
    /** @deprecated Import `ProgressIndicator` from `@opencroft/client/ui`. */
    ProgressIndicator,
    /** @deprecated Import `ProgressLabel` from `@opencroft/client/ui`. */
    ProgressLabel,
    /** @deprecated Import `ProgressTrack` from `@opencroft/client/ui`. */
    ProgressTrack,
    /** @deprecated Import `ProgressValue` from `@opencroft/client/ui`. */
    ProgressValue,
    /** @deprecated Import `RadioGroup` from `@opencroft/client/ui`. */
    RadioGroup,
    /** @deprecated Import `RadioGroupItem` from `@opencroft/client/ui`. */
    RadioGroupItem,
    /** @deprecated Import `RecyclingView` from `@opencroft/client/ui`. */
    RecyclingView,
    /** @deprecated Import `ResizableHandle` from `@opencroft/client/ui`. */
    ResizableHandle,
    /** @deprecated Import `ResizablePanel` from `@opencroft/client/ui`. */
    ResizablePanel,
    /** @deprecated Import `ResizablePanelGroup` from `@opencroft/client/ui`. */
    ResizablePanelGroup,
    /** @deprecated Import `reorderedIds` from `@opencroft/client/ui`. */
    reorderedIds,
    /** @deprecated Import `SaveFileFields` from `@opencroft/client/ui`. */
    SaveFileFields,
    /** @deprecated Import `Schedules` from `@opencroft/client/ui`. */
    Schedules,
    /** @deprecated Import `ScrollArea` from `@opencroft/client/ui`. */
    ScrollArea,
    /** @deprecated Import `ScrollBar` from `@opencroft/client/ui`. */
    ScrollBar,
    /** @deprecated Import `ScrollContent` from `@opencroft/client/ui`. */
    ScrollContent,
    /** @deprecated Import `ScrollFooter` from `@opencroft/client/ui`. */
    ScrollFooter,
    /** @deprecated Import `ScrollHeader` from `@opencroft/client/ui`. */
    ScrollHeader,
    /** @deprecated Import `ScrollPage` from `@opencroft/client/ui`. */
    ScrollPage,
    /** @deprecated Import `ScrollToBottomButton` from `@opencroft/client/ui`. */
    ScrollToBottomButton,
    /** @deprecated Import `SearchableDropdown` from `@opencroft/client/ui`. */
    SearchableDropdown,
    /** @deprecated Import `SecretInput` from `@opencroft/client/ui`. */
    SecretInput,
    /** @deprecated Import `Select` from `@opencroft/client/ui`. */
    Select,
    /** @deprecated Import `SelectContent` from `@opencroft/client/ui`. */
    SelectContent,
    /** @deprecated Import `SelectGroup` from `@opencroft/client/ui`. */
    SelectGroup,
    /** @deprecated Import `SelectItem` from `@opencroft/client/ui`. */
    SelectItem,
    /** @deprecated Import `SelectLabel` from `@opencroft/client/ui`. */
    SelectLabel,
    /** @deprecated Import `SelectScrollDownButton` from `@opencroft/client/ui`. */
    SelectScrollDownButton,
    /** @deprecated Import `SelectScrollUpButton` from `@opencroft/client/ui`. */
    SelectScrollUpButton,
    /** @deprecated Import `SelectSeparator` from `@opencroft/client/ui`. */
    SelectSeparator,
    /** @deprecated Import `SelectTrigger` from `@opencroft/client/ui`. */
    SelectTrigger,
    /** @deprecated Import `SelectValue` from `@opencroft/client/ui`. */
    SelectValue,
    /** @deprecated Import `Separator` from `@opencroft/client/ui`. */
    Separator,
    /** @deprecated Import `Sheet` from `@opencroft/client/ui`. */
    Sheet,
    /** @deprecated Import `SheetClose` from `@opencroft/client/ui`. */
    SheetClose,
    /** @deprecated Import `SheetContent` from `@opencroft/client/ui`. */
    SheetContent,
    /** @deprecated Import `SheetDescription` from `@opencroft/client/ui`. */
    SheetDescription,
    /** @deprecated Import `SheetFooter` from `@opencroft/client/ui`. */
    SheetFooter,
    /** @deprecated Import `SheetHeader` from `@opencroft/client/ui`. */
    SheetHeader,
    /** @deprecated Import `SheetTitle` from `@opencroft/client/ui`. */
    SheetTitle,
    /** @deprecated Import `SheetTrigger` from `@opencroft/client/ui`. */
    SheetTrigger,
    /** @deprecated Import `Sidebar` from `@opencroft/client/ui`. */
    Sidebar,
    /** @deprecated Import `SidebarContent` from `@opencroft/client/ui`. */
    SidebarContent,
    /** @deprecated Import `SidebarFooter` from `@opencroft/client/ui`. */
    SidebarFooter,
    /** @deprecated Import `SidebarGroup` from `@opencroft/client/ui`. */
    SidebarGroup,
    /** @deprecated Import `SidebarGroupAction` from `@opencroft/client/ui`. */
    SidebarGroupAction,
    /** @deprecated Import `SidebarGroupContent` from `@opencroft/client/ui`. */
    SidebarGroupContent,
    /** @deprecated Import `SidebarGroupLabel` from `@opencroft/client/ui`. */
    SidebarGroupLabel,
    /** @deprecated Import `SidebarHeader` from `@opencroft/client/ui`. */
    SidebarHeader,
    /** @deprecated Import `SidebarInput` from `@opencroft/client/ui`. */
    SidebarInput,
    /** @deprecated Import `SidebarInset` from `@opencroft/client/ui`. */
    SidebarInset,
    /** @deprecated Import `SidebarMenu` from `@opencroft/client/ui`. */
    SidebarMenu,
    /** @deprecated Import `SidebarMenuAction` from `@opencroft/client/ui`. */
    SidebarMenuAction,
    /** @deprecated Import `SidebarMenuBadge` from `@opencroft/client/ui`. */
    SidebarMenuBadge,
    /** @deprecated Import `SidebarMenuButton` from `@opencroft/client/ui`. */
    SidebarMenuButton,
    /** @deprecated Import `SidebarMenuItem` from `@opencroft/client/ui`. */
    SidebarMenuItem,
    /** @deprecated Import `SidebarMenuSkeleton` from `@opencroft/client/ui`. */
    SidebarMenuSkeleton,
    /** @deprecated Import `SidebarMenuSub` from `@opencroft/client/ui`. */
    SidebarMenuSub,
    /** @deprecated Import `SidebarMenuSubButton` from `@opencroft/client/ui`. */
    SidebarMenuSubButton,
    /** @deprecated Import `SidebarMenuSubItem` from `@opencroft/client/ui`. */
    SidebarMenuSubItem,
    /** @deprecated Import `SidebarProvider` from `@opencroft/client/ui`. */
    SidebarProvider,
    /** @deprecated Import `SidebarRail` from `@opencroft/client/ui`. */
    SidebarRail,
    /** @deprecated Import `SidebarSeparator` from `@opencroft/client/ui`. */
    SidebarSeparator,
    /** @deprecated Import `SidebarTrigger` from `@opencroft/client/ui`. */
    SidebarTrigger,
    /** @deprecated Import `Skeleton` from `@opencroft/client/ui`. */
    Skeleton,
    /** @deprecated Import `Slider` from `@opencroft/client/ui`. */
    Slider,
    /** @deprecated Import `Spinner` from `@opencroft/client/ui`. */
    Spinner,
    /** @deprecated Import `StatusIndicator` from `@opencroft/client/ui`. */
    StatusIndicator,
    /** @deprecated Import `Switch` from `@opencroft/client/ui`. */
    Switch,
    /** @deprecated Import `secretFieldAttributes` from `@opencroft/client/ui`. */
    secretFieldAttributes,
    /** @deprecated Import `Table` from `@opencroft/client/ui`. */
    Table,
    /** @deprecated Import `TableBody` from `@opencroft/client/ui`. */
    TableBody,
    /** @deprecated Import `TableCaption` from `@opencroft/client/ui`. */
    TableCaption,
    /** @deprecated Import `TableCell` from `@opencroft/client/ui`. */
    TableCell,
    /** @deprecated Import `TableFooter` from `@opencroft/client/ui`. */
    TableFooter,
    /** @deprecated Import `TableHead` from `@opencroft/client/ui`. */
    TableHead,
    /** @deprecated Import `TableHeader` from `@opencroft/client/ui`. */
    TableHeader,
    /** @deprecated Import `TableRow` from `@opencroft/client/ui`. */
    TableRow,
    /** @deprecated Import `Tabs` from `@opencroft/client/ui`. */
    Tabs,
    /** @deprecated Import `TabsContent` from `@opencroft/client/ui`. */
    TabsContent,
    /** @deprecated Import `TabsList` from `@opencroft/client/ui`. */
    TabsList,
    /** @deprecated Import `TabsTrigger` from `@opencroft/client/ui`. */
    TabsTrigger,
    /** @deprecated Import `Textarea` from `@opencroft/client/ui`. */
    Textarea,
    /** @deprecated Import `ThemeProvider` from `@opencroft/client/ui`. */
    ThemeProvider,
    /** @deprecated Import `Toaster` from `@opencroft/client/ui`. */
    Toaster,
    /** @deprecated Import `Toggle` from `@opencroft/client/ui`. */
    Toggle,
    /** @deprecated Import `ToggleGroup` from `@opencroft/client/ui`. */
    ToggleGroup,
    /** @deprecated Import `ToggleGroupItem` from `@opencroft/client/ui`. */
    ToggleGroupItem,
    /** @deprecated Import `Tooltip` from `@opencroft/client/ui`. */
    Tooltip,
    /** @deprecated Import `TooltipContent` from `@opencroft/client/ui`. */
    TooltipContent,
    /** @deprecated Import `TooltipProvider` from `@opencroft/client/ui`. */
    TooltipProvider,
    /** @deprecated Import `TooltipTrigger` from `@opencroft/client/ui`. */
    TooltipTrigger,
    /** @deprecated Import `TypingDots` from `@opencroft/client/ui`. */
    TypingDots,
    /** @deprecated Import `tabsListVariants` from `@opencroft/client/ui`. */
    tabsListVariants,
    /** @deprecated Import `toggleVariants` from `@opencroft/client/ui`. */
    toggleVariants,
    /** @deprecated Import `useCarousel` from `@opencroft/client/ui`. */
    useCarousel,
    /** @deprecated Import `useComboboxAnchor` from `@opencroft/client/ui`. */
    useComboboxAnchor,
    /** @deprecated Import `useDirection` from `@opencroft/client/ui`. */
    useDirection,
    /** @deprecated Import `useScrollToBottom` from `@opencroft/client/ui`. */
    useScrollToBottom,
    /** @deprecated Import `useSidebar` from `@opencroft/client/ui`. */
    useSidebar,
    /** @deprecated Import `validateCron` from `@opencroft/client/ui`. */
    validateCron,
  } from '@opencroft/client/ui'
  export type {
    /** @deprecated Import `AcceptedTypes` from `@opencroft/client/values`. */
    AcceptedTypes,
    /** @deprecated Import `CompiledPattern` from `@opencroft/client/values`. */
    CompiledPattern,
    /** @deprecated Import `EnumCasesField` from `@opencroft/client/values`. */
    EnumCasesField,
    /** @deprecated Import `EnumCasesOf` from `@opencroft/client/values`. */
    EnumCasesOf,
    /** @deprecated Import `EvaluateExpressionResult` from `@opencroft/client/values`. */
    EvaluateExpressionResult,
    /** @deprecated Import `ExpressionError` from `@opencroft/client/values`. */
    ExpressionError,
    /** @deprecated Import `ExpressionNode` from `@opencroft/client/values`. */
    ExpressionNode,
    /** @deprecated Import `ExpressionType` from `@opencroft/client/values`. */
    ExpressionType,
    /** @deprecated Import `ExpressionTypes` from `@opencroft/client/values`. */
    ExpressionTypes,
    /** @deprecated Import `FileCollision` from `@opencroft/client/values`. */
    FileCollision,
    /** @deprecated Import `FileNameToken` from `@opencroft/client/values`. */
    FileNameToken,
    /** @deprecated Import `FileSaveSettings` from `@opencroft/client/values`. */
    FileSaveSettings,
    /** @deprecated Import `FormatTemplateResult` from `@opencroft/client/values`. */
    FormatTemplateResult,
    /** @deprecated Import `GroupType` from `@opencroft/client/values`. */
    GroupType,
    /** @deprecated Import `InlineValueFields` from `@opencroft/client/values`. */
    InlineValueFields,
    /** @deprecated Import `ObjectValue` from `@opencroft/client/values`. */
    ObjectValue,
    /** @deprecated Import `ParsedExpression` from `@opencroft/client/values`. */
    ParsedExpression,
    /** @deprecated Import `ParsedTemplate` from `@opencroft/client/values`. */
    ParsedTemplate,
    /** @deprecated Import `ParseExpressionResult` from `@opencroft/client/values`. */
    ParseExpressionResult,
    /** @deprecated Import `ParsePathResult` from `@opencroft/client/values`. */
    ParsePathResult,
    /** @deprecated Import `Pattern` from `@opencroft/client/values`. */
    Pattern,
    /** @deprecated Import `PatternGroup` from `@opencroft/client/values`. */
    PatternGroup,
    /** @deprecated Import `PatternMatch` from `@opencroft/client/values`. */
    PatternMatch,
    /** @deprecated Import `PrimitiveValue` from `@opencroft/client/values`. */
    PrimitiveValue,
    /** @deprecated Import `ReadPathResult` from `@opencroft/client/values`. */
    ReadPathResult,
    /** @deprecated Import `ReplaceResult` from `@opencroft/client/values`. */
    ReplaceResult,
    /** @deprecated Import `ResolvedInputEntry` from `@opencroft/client/values`. */
    ResolvedInputEntry,
    /** @deprecated Import `SwitchCase` from `@opencroft/client/values`. */
    SwitchCase,
    /** @deprecated Import `SwitchOutputResult` from `@opencroft/client/values`. */
    SwitchOutputResult,
    /** @deprecated Import `SwitchSettings` from `@opencroft/client/values`. */
    SwitchSettings,
    /** @deprecated Import `TemplateError` from `@opencroft/client/values`. */
    TemplateError,
    /** @deprecated Import `TemplatePlaceholder` from `@opencroft/client/values`. */
    TemplatePlaceholder,
    /** @deprecated Import `Value` from `@opencroft/client/values`. */
    Value,
    /** @deprecated Import `ValueHandle` from `@opencroft/client/values`. */
    ValueHandle,
    /** @deprecated Import `ValueOption` from `@opencroft/client/values`. */
    ValueOption,
    /** @deprecated Import `WiredValue` from `@opencroft/client/values`. */
    WiredValue,
  } from '@opencroft/client/values'
}

// GENERATED from the extension API modules and the host's runtime surface by
// apps/opencroft/app/_authed/(extension-runtime)/_server/legacy-declarations.ts.
// Do not edit: run `npm run generate:legacy-declarations -w apps/opencroft`.
/**
 * `legacy` — the deprecated `@ext/host` + `@ext/ui` client surface under one
 * namespace. Every name here is its module's own, re-exported; import it from
 * that module instead.
 */

export {
  /** @deprecated Use `import React from 'react'` (or the hooks by name). */
  default as React,
} from 'react'
export {
  /** @deprecated Use `import { createPortal } from 'react-dom'`. */
  createPortal,
} from 'react-dom'

export {
  /** @deprecated Import `callAppAction` from `@opencroft/client/actions`. */
  callAppAction,
  /** @deprecated Import `dispatch` from `@opencroft/client/actions`. */
  dispatch,
  /** @deprecated Import `invoke` from `@opencroft/client/actions`. */
  invoke,
} from './actions'
export {
  /** @deprecated Import `AppActions` from `@opencroft/client/app`. */
  AppActions,
  /** @deprecated Import `AppComponentProps` from `@opencroft/client/app`. */
  type AppComponentProps,
  /** @deprecated Import `AppDefinition` from `@opencroft/client/app`. */
  type AppDefinition,
  /** @deprecated Import `AppFormProps` from `@opencroft/client/app`. */
  type AppFormProps,
  /** @deprecated Import `AppLink` from `@opencroft/client/app`. */
  AppLink,
  /** @deprecated Import `AppLinkProps` from `@opencroft/client/app`. */
  type AppLinkProps,
  /** @deprecated Import `AppLocation` from `@opencroft/client/app`. */
  type AppLocation,
  /** @deprecated Import `AppNavigateOptions` from `@opencroft/client/app`. */
  type AppNavigateOptions,
  /** @deprecated Import `AppSidebar` from `@opencroft/client/app`. */
  AppSidebar,
  /** @deprecated Import `AppSidebarProps` from `@opencroft/client/app`. */
  type AppSidebarProps,
  /** @deprecated Import `AppTitle` from `@opencroft/client/app`. */
  AppTitle,
  /** @deprecated Import `AppToolbar` from `@opencroft/client/app`. */
  AppToolbar,
  /** @deprecated Import `UrlParamControls` from `@opencroft/client/app`. */
  type UrlParamControls,
  /** @deprecated Import `UrlParamWriteOptions` from `@opencroft/client/app`. */
  type UrlParamWriteOptions,
  /** @deprecated Import `useAppAddressHref` from `@opencroft/client/app`. */
  useAppAddressHref,
  /** @deprecated Import `useAppHref` from `@opencroft/client/app`. */
  useAppHref,
  /** @deprecated Import `useAppLocation` from `@opencroft/client/app`. */
  useAppLocation,
  /** @deprecated Import `useAppNavigate` from `@opencroft/client/app`. */
  useAppNavigate,
  /** @deprecated Import `useIsMobile` from `@opencroft/client/app`. */
  useIsMobile,
  /** @deprecated Import `useOpenApp` from `@opencroft/client/app`. */
  useOpenApp,
  /** @deprecated Import `useUrlParam` from `@opencroft/client/app`. */
  useUrlParam,
} from './app'
export {
  /** @deprecated Import `CommandBar` from `@opencroft/client/canvas`. */
  CommandBar,
  /** @deprecated Import `CommandBarMenu` from `@opencroft/client/canvas`. */
  CommandBarMenu,
  /** @deprecated Import `CommandBarMenuItem` from `@opencroft/client/canvas`. */
  CommandBarMenuItem,
  /** @deprecated Import `CommandBarNode` from `@opencroft/client/canvas`. */
  type CommandBarNode,
  /** @deprecated Import `CommandModeDefinition` from `@opencroft/client/canvas`. */
  type CommandModeDefinition,
  /** @deprecated Import `CommandModeProps` from `@opencroft/client/canvas`. */
  type CommandModeProps,
  /** @deprecated Import `CommandModeShortcut` from `@opencroft/client/canvas`. */
  type CommandModeShortcut,
  /** @deprecated Import `ExtensionComponentProps` from `@opencroft/client/canvas`. */
  type ExtensionComponentProps,
  /** @deprecated Import `ExtensionContextType` from `@opencroft/client/canvas`. */
  type ExtensionContextType,
  /** @deprecated Import `ExtensionHandle` from `@opencroft/client/canvas`. */
  type ExtensionHandle,
  /** @deprecated Import `ExtensionHandleType` from `@opencroft/client/canvas`. */
  type ExtensionHandleType,
  /** @deprecated Import `ExtensionInspectorProps` from `@opencroft/client/canvas`. */
  type ExtensionInspectorProps,
  /** @deprecated Import `GraphCanvas` from `@opencroft/client/canvas`. */
  GraphCanvas,
  /** @deprecated Import `Handle` from `@opencroft/client/canvas`. */
  Handle,
  /** @deprecated Import `HandlePinProps` from `@opencroft/client/canvas`. */
  type HandlePinProps,
  /** @deprecated Import `InputHandle` from `@opencroft/client/canvas`. */
  InputHandle,
  /** @deprecated Import `InspectorIntent` from `@opencroft/client/canvas`. */
  type InspectorIntent,
  /** @deprecated Import `InspectorTab` from `@opencroft/client/canvas`. */
  type InspectorTab,
  /** @deprecated Import `inspectorIntent` from `@opencroft/client/canvas`. */
  inspectorIntent,
  /** @deprecated Import `NodeCard` from `@opencroft/client/canvas`. */
  NodeCard,
  /** @deprecated Import `NodeCardContent` from `@opencroft/client/canvas`. */
  NodeCardContent,
  /** @deprecated Import `NodeCardHeader` from `@opencroft/client/canvas`. */
  NodeCardHeader,
  /** @deprecated Import `NodeContextMenuContext` from `@opencroft/client/canvas`. */
  type NodeContextMenuContext,
  /** @deprecated Import `NodeContextMenuItem` from `@opencroft/client/canvas`. */
  type NodeContextMenuItem,
  /** @deprecated Import `NodeDefinition` from `@opencroft/client/canvas`. */
  type NodeDefinition,
  /** @deprecated Import `NodeFrame` from `@opencroft/client/canvas`. */
  NodeFrame,
  /** @deprecated Import `NodeResizer` from `@opencroft/client/canvas`. */
  NodeResizer,
  /** @deprecated Import `OutputHandle` from `@opencroft/client/canvas`. */
  OutputHandle,
  /** @deprecated Import `OverlayControl` from `@opencroft/client/canvas`. */
  type OverlayControl,
  /** @deprecated Import `Position` from `@opencroft/client/canvas`. */
  Position,
  /** @deprecated Import `ResolvedContext` from `@opencroft/client/canvas`. */
  type ResolvedContext,
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
} from './canvas'
export {
  /** @deprecated Import `AgentChatInputControl` from `@opencroft/client/chat`. */
  type AgentChatInputControl,
  /** @deprecated Import `AgentChatInputControlProps` from `@opencroft/client/chat`. */
  type AgentChatInputControlProps,
  /** @deprecated Import `AgentChatMessage` from `@opencroft/client/chat`. */
  type AgentChatMessage,
  /** @deprecated Import `AgentChatStatusIndicator` from `@opencroft/client/chat`. */
  type AgentChatStatusIndicator,
  /** @deprecated Import `ChatDock` from `@opencroft/client/chat`. */
  ChatDock,
  /** @deprecated Import `ChatDockControl` from `@opencroft/client/chat`. */
  type ChatDockControl,
  /** @deprecated Import `ChatDockProps` from `@opencroft/client/chat`. */
  type ChatDockProps,
  /** @deprecated Import `ChatSelector` from `@opencroft/client/chat`. */
  ChatSelector,
  /** @deprecated Import `ChatSelectorProps` from `@opencroft/client/chat`. */
  type ChatSelectorProps,
  /** @deprecated Import `describeMentionedAccounts` from `@opencroft/client/chat`. */
  describeMentionedAccounts,
  /** @deprecated Import `EmbeddedAgentChat` from `@opencroft/client/chat`. */
  EmbeddedAgentChat,
  /** @deprecated Import `EmbeddedAgentChatProps` from `@opencroft/client/chat`. */
  type EmbeddedAgentChatProps,
  /** @deprecated Import `EmbeddedChatSelection` from `@opencroft/client/chat`. */
  type EmbeddedChatSelection,
  /** @deprecated Import `MentionedAccount` from `@opencroft/client/chat`. */
  type MentionedAccount,
  /** @deprecated Import `SelectionContextValue` from `@opencroft/client/chat`. */
  type SelectionContextValue,
  /** @deprecated Import `SelectionProvider` from `@opencroft/client/chat`. */
  SelectionProvider,
  /** @deprecated Import `UserSelection` from `@opencroft/client/chat`. */
  type UserSelection,
  /** @deprecated Import `useChatDock` from `@opencroft/client/chat`. */
  useChatDock,
  /** @deprecated Import `useSelection` from `@opencroft/client/chat`. */
  useSelection,
} from './chat'
export {
  /** @deprecated Import `CodeBlock` from `@opencroft/client/code`. */
  CodeBlock,
  /** @deprecated Import `CodeBlockEditor` from `@opencroft/client/code`. */
  CodeBlockEditor,
  /** @deprecated Import `CodeBlockEditorProps` from `@opencroft/client/code`. */
  type CodeBlockEditorProps,
  /** @deprecated Import `CodeBlockProps` from `@opencroft/client/code`. */
  type CodeBlockProps,
  /** @deprecated Import `CodeEditor` from `@opencroft/client/code`. */
  CodeEditor,
  /** @deprecated Import `CodeEditorDiffMode` from `@opencroft/client/code`. */
  type CodeEditorDiffMode,
  /** @deprecated Import `CodeEditorHideUnchangedRegions` from `@opencroft/client/code`. */
  type CodeEditorHideUnchangedRegions,
  /** @deprecated Import `CodeEditorLanguage` from `@opencroft/client/code`. */
  type CodeEditorLanguage,
  /** @deprecated Import `CodeEditorOnMount` from `@opencroft/client/code`. */
  type CodeEditorOnMount,
  /** @deprecated Import `CodeEditorProps` from `@opencroft/client/code`. */
  type CodeEditorProps,
  /** @deprecated Import `MonacoCodeEditor` from `@opencroft/client/code`. */
  type MonacoCodeEditor,
  /** @deprecated Import `MonacoDiffEditor` from `@opencroft/client/code`. */
  type MonacoDiffEditor,
  /** @deprecated Import `MonacoNamespace` from `@opencroft/client/code`. */
  type MonacoNamespace,
} from './code'
export {
  /** @deprecated Import `DockerContainerSnapshot` from `@opencroft/client/docker`. */
  type DockerContainerSnapshot,
  /** @deprecated Import `useDockerContainers` from `@opencroft/client/docker`. */
  useDockerContainers,
  /** @deprecated Import `useDockerSnapshotReceived` from `@opencroft/client/docker`. */
  useDockerSnapshotReceived,
  /** @deprecated Import `useSeedDockerContainers` from `@opencroft/client/docker`. */
  useSeedDockerContainers,
} from './docker'
export {
  /** @deprecated Import `absoluteUrl` from `@opencroft/client/extension`. */
  absoluteUrl,
  /** @deprecated Import `assetUrl` from `@opencroft/client/extension`. */
  assetUrl,
  /** @deprecated Import `defineExtension` from `@opencroft/client/extension`. */
  defineExtension,
  /** @deprecated Import `ExtensionDeclaration` from `@opencroft/client/extension`. */
  type ExtensionDeclaration,
  /** @deprecated Import `ExtensionDeclarationManifest` from `@opencroft/client/extension`. */
  type ExtensionDeclarationManifest,
  /** @deprecated Import `extensionId` from `@opencroft/client/extension`. */
  extensionId,
  /** @deprecated Import `ProvidedPoints` from `@opencroft/client/extension`. */
  type ProvidedPoints,
  /** @deprecated Import `RightSidebarPanel` from `@opencroft/client/extension`. */
  type RightSidebarPanel,
  /** @deprecated Import `routeUrl` from `@opencroft/client/extension`. */
  routeUrl,
  /** @deprecated Import `SettingsPageDefinition` from `@opencroft/client/extension`. */
  type SettingsPageDefinition,
  /** @deprecated Import `urlBase` from `@opencroft/client/extension`. */
  urlBase,
} from './extension'
export {
  /** @deprecated Import `FileBrowser` from `@opencroft/client/files`. */
  FileBrowser,
  /** @deprecated Import `FileManagerProvider` from `@opencroft/client/files`. */
  FileManagerProvider,
} from './files'
export {
  /** @deprecated Import `describeGraphRefs` from `@opencroft/client/graph`. */
  describeGraphRefs,
  /** @deprecated Import `GraphRefDescription` from `@opencroft/client/graph`. */
  type GraphRefDescription,
  /** @deprecated Import `NodeRef` from `@opencroft/client/graph`. */
  NodeRef,
  /** @deprecated Import `NodeRefProps` from `@opencroft/client/graph`. */
  type NodeRefProps,
  /** @deprecated Import `subscribeGraphRefs` from `@opencroft/client/graph`. */
  subscribeGraphRefs,
} from './graph'
export {
  /** @deprecated Import `Markdown` from `@opencroft/client/markdown`. */
  Markdown,
  /** @deprecated Import `MarkdownDiffView` from `@opencroft/client/markdown`. */
  MarkdownDiffView,
  /** @deprecated Import `MarkdownDiffViewProps` from `@opencroft/client/markdown`. */
  type MarkdownDiffViewProps,
  /** @deprecated Import `MarkdownEditor` from `@opencroft/client/markdown`. */
  MarkdownEditor,
  /** @deprecated Import `MarkdownEditorOwnDocument` from `@opencroft/client/markdown`. */
  type MarkdownEditorOwnDocument,
  /** @deprecated Import `MarkdownEditorProps` from `@opencroft/client/markdown`. */
  type MarkdownEditorProps,
  /** @deprecated Import `MarkdownEditorSharedDocument` from `@opencroft/client/markdown`. */
  type MarkdownEditorSharedDocument,
  /** @deprecated Import `MarkdownEditorSurfaceProps` from `@opencroft/client/markdown`. */
  type MarkdownEditorSurfaceProps,
  /** @deprecated Import `MarkdownEditorToolbarGroup` from `@opencroft/client/markdown`. */
  type MarkdownEditorToolbarGroup,
  /** @deprecated Import `MarkdownProps` from `@opencroft/client/markdown`. */
  type MarkdownProps,
  /** @deprecated Import `MarkdownReference` from `@opencroft/client/markdown`. */
  type MarkdownReference,
  /** @deprecated Import `MarkdownReferenceMenuItem` from `@opencroft/client/markdown`. */
  type MarkdownReferenceMenuItem,
  /** @deprecated Import `MarkdownReferenceTone` from `@opencroft/client/markdown`. */
  type MarkdownReferenceTone,
  /** @deprecated Import `MarkdownResolver` from `@opencroft/client/markdown`. */
  type MarkdownResolver,
  /** @deprecated Import `MermaidDiagram` from `@opencroft/client/markdown`. */
  MermaidDiagram,
  /** @deprecated Import `MermaidDiagramProps` from `@opencroft/client/markdown`. */
  type MermaidDiagramProps,
  /** @deprecated Import `markdownDirectiveBlocks` from `@opencroft/client/markdown`. */
  markdownDirectiveBlocks,
} from './markdown'
export {
  /** @deprecated Import `SecretSelector` from `@opencroft/client/secrets`. */
  SecretSelector,
  /** @deprecated Import `SecretSelectorProps` from `@opencroft/client/secrets`. */
  type SecretSelectorProps,
} from './secrets'
export {
  /** @deprecated Import `createStorage` from `@opencroft/client/storage`. */
  createStorage,
  /** @deprecated Import `ExtensionStorage` from `@opencroft/client/storage`. */
  type ExtensionStorage,
} from './storage'
export {
  /** @deprecated Import `broadcast` from `@opencroft/client/streams`. */
  broadcast,
  /** @deprecated Import `getStream` from `@opencroft/client/streams`. */
  getStream,
  /** @deprecated Import `Stream` from `@opencroft/client/streams`. */
  type Stream,
  /** @deprecated Import `subscribe` from `@opencroft/client/streams`. */
  subscribe,
  /** @deprecated Import `TextChunk` from `@opencroft/client/streams`. */
  type TextChunk,
} from './streams'
export {
  /** @deprecated Import `Terminal` from `@opencroft/client/terminal`. */
  Terminal,
  /** @deprecated Use `Terminal` from `@opencroft/client/terminal`. */
  Terminal as InspectorTerminalBody,
  /** @deprecated Import `TerminalConfig` from `@opencroft/client/terminal`. */
  type TerminalConfig,
  /** @deprecated Import `TerminalList` from `@opencroft/client/terminal`. */
  TerminalList,
  /** @deprecated Import `TerminalListProps` from `@opencroft/client/terminal`. */
  type TerminalListProps,
  /** @deprecated Import `TerminalProps` from `@opencroft/client/terminal`. */
  type TerminalProps,
  /** @deprecated Import `TerminalRef` from `@opencroft/client/terminal`. */
  TerminalRef,
  /** @deprecated Import `TerminalRefProps` from `@opencroft/client/terminal`. */
  type TerminalRefProps,
  /** @deprecated Import `TerminalSelector` from `@opencroft/client/terminal`. */
  TerminalSelector,
  /** @deprecated Import `TerminalSelectorProps` from `@opencroft/client/terminal`. */
  type TerminalSelectorProps,
  /** @deprecated Import `TerminalStatus` from `@opencroft/client/terminal`. */
  type TerminalStatus,
} from './terminal'
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
  /** @deprecated Import `AccountCardProps` from `@opencroft/client/ui`. */
  type AccountCardProps,
  /** @deprecated Import `AdaptivePopup` from `@opencroft/client/ui`. */
  AdaptivePopup,
  /** @deprecated Import `AdaptivePopupProps` from `@opencroft/client/ui`. */
  type AdaptivePopupProps,
  /** @deprecated Import `AgentAvatar` from `@opencroft/client/ui`. */
  AgentAvatar,
  /** @deprecated Import `AgentAvatarSize` from `@opencroft/client/ui`. */
  type AgentAvatarSize,
  /** @deprecated Import `AgentJobRef` from `@opencroft/client/ui`. */
  type AgentJobRef,
  /** @deprecated Import `AgentRef` from `@opencroft/client/ui`. */
  type AgentRef,
  /** @deprecated Import `AgentSessionGroup` from `@opencroft/client/ui`. */
  type AgentSessionGroup,
  /** @deprecated Import `AgentSessionList` from `@opencroft/client/ui`. */
  AgentSessionList,
  /** @deprecated Import `AgentSessionListProps` from `@opencroft/client/ui`. */
  type AgentSessionListProps,
  /** @deprecated Import `AgentSessionSummary` from `@opencroft/client/ui`. */
  type AgentSessionSummary,
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
  /** @deprecated Import `AlignItems` from `@opencroft/client/ui`. */
  type AlignItems,
  /** @deprecated Import `ApiToken` from `@opencroft/client/ui`. */
  type ApiToken,
  /** @deprecated Import `ApiTokenCreateForm` from `@opencroft/client/ui`. */
  ApiTokenCreateForm,
  /** @deprecated Import `ApiTokenCreateFormProps` from `@opencroft/client/ui`. */
  type ApiTokenCreateFormProps,
  /** @deprecated Import `ApiTokenExpiryOption` from `@opencroft/client/ui`. */
  type ApiTokenExpiryOption,
  /** @deprecated Import `ApiTokenList` from `@opencroft/client/ui`. */
  ApiTokenList,
  /** @deprecated Import `ApiTokenListProps` from `@opencroft/client/ui`. */
  type ApiTokenListProps,
  /** @deprecated Import `ApiTokenReveal` from `@opencroft/client/ui`. */
  ApiTokenReveal,
  /** @deprecated Import `ApiTokenRevealProps` from `@opencroft/client/ui`. */
  type ApiTokenRevealProps,
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
  /** @deprecated Import `CarouselApi` from `@opencroft/client/ui`. */
  type CarouselApi,
  /** @deprecated Import `CarouselContent` from `@opencroft/client/ui`. */
  CarouselContent,
  /** @deprecated Import `CarouselItem` from `@opencroft/client/ui`. */
  CarouselItem,
  /** @deprecated Import `CarouselNext` from `@opencroft/client/ui`. */
  CarouselNext,
  /** @deprecated Import `CarouselPrevious` from `@opencroft/client/ui`. */
  CarouselPrevious,
  /** @deprecated Import `ChartConfig` from `@opencroft/client/ui`. */
  type ChartConfig,
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
  /** @deprecated Import `ChatInputProps` from `@opencroft/client/ui`. */
  type ChatInputProps,
  /** @deprecated Import `ChatMessage` from `@opencroft/client/ui`. */
  ChatMessage,
  /** @deprecated Import `ChatMessageProps` from `@opencroft/client/ui`. */
  type ChatMessageProps,
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
  /** @deprecated Import `ControlledInputProps` from `@opencroft/client/ui`. */
  type ControlledInputProps,
  /** @deprecated Import `ControlledTextarea` from `@opencroft/client/ui`. */
  ControlledTextarea,
  /** @deprecated Import `ControlledTextareaProps` from `@opencroft/client/ui`. */
  type ControlledTextareaProps,
  /** @deprecated Import `createIFrameRoute` from `@opencroft/client/ui`. */
  createIFrameRoute,
  /** @deprecated Import `Dialog` from `@opencroft/client/ui`. */
  Dialog,
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
  /** @deprecated Import `ExampleFrame` from `@opencroft/client/ui`. */
  ExampleFrame,
  /** @deprecated Import `ExampleFrameProps` from `@opencroft/client/ui`. */
  type ExampleFrameProps,
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
  /** @deprecated Import `FixedAreaProps` from `@opencroft/client/ui`. */
  type FixedAreaProps,
  /** @deprecated Import `Flex` from `@opencroft/client/ui`. */
  Flex,
  /** @deprecated Import `FlexDirection` from `@opencroft/client/ui`. */
  type FlexDirection,
  /** @deprecated Import `FlexProps` from `@opencroft/client/ui`. */
  type FlexProps,
  /** @deprecated Import `Grid` from `@opencroft/client/ui`. */
  Grid,
  /** @deprecated Import `GridProps` from `@opencroft/client/ui`. */
  type GridProps,
  /** @deprecated Import `GridSize` from `@opencroft/client/ui`. */
  type GridSize,
  /** @deprecated Import `GridSizeSwitcher` from `@opencroft/client/ui`. */
  GridSizeSwitcher,
  /** @deprecated Import `GridSizeSwitcherProps` from `@opencroft/client/ui`. */
  type GridSizeSwitcherProps,
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
  /** @deprecated Import `ImageAreaProps` from `@opencroft/client/ui`. */
  type ImageAreaProps,
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
  /** @deprecated Import `JustifyContent` from `@opencroft/client/ui`. */
  type JustifyContent,
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
  /** @deprecated Import `MenuLayoutProps` from `@opencroft/client/ui`. */
  type MenuLayoutProps,
  /** @deprecated Import `NamedSection` from `@opencroft/client/ui`. */
  NamedSection,
  /** @deprecated Import `NamedSectionProps` from `@opencroft/client/ui`. */
  type NamedSectionProps,
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
  /** @deprecated Import `navigationMenuTriggerStyle` from `@opencroft/client/ui`. */
  navigationMenuTriggerStyle,
  /** @deprecated Import `Page` from `@opencroft/client/ui`. */
  Page,
  /** @deprecated Import `PageProps` from `@opencroft/client/ui`. */
  type PageProps,
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
  /** @deprecated Import `PopupContentProps` from `@opencroft/client/ui`. */
  type PopupContentProps,
  /** @deprecated Import `PopupFooter` from `@opencroft/client/ui`. */
  PopupFooter,
  /** @deprecated Import `PopupFooterProps` from `@opencroft/client/ui`. */
  type PopupFooterProps,
  /** @deprecated Import `PopupHeader` from `@opencroft/client/ui`. */
  PopupHeader,
  /** @deprecated Import `PopupHeaderProps` from `@opencroft/client/ui`. */
  type PopupHeaderProps,
  /** @deprecated Import `PopupRecyclingContent` from `@opencroft/client/ui`. */
  PopupRecyclingContent,
  /** @deprecated Import `PopupRecyclingContentProps` from `@opencroft/client/ui`. */
  type PopupRecyclingContentProps,
  /** @deprecated Import `PopupSubHeader` from `@opencroft/client/ui`. */
  PopupSubHeader,
  /** @deprecated Import `PopupSubHeaderProps` from `@opencroft/client/ui`. */
  type PopupSubHeaderProps,
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
  /** @deprecated Import `RunHistoryEntry` from `@opencroft/client/ui`. */
  type RunHistoryEntry,
  /** @deprecated Import `RunStatus` from `@opencroft/client/ui`. */
  type RunStatus,
  /** @deprecated Import `ScheduleMode` from `@opencroft/client/ui`. */
  type ScheduleMode,
  /** @deprecated Import `ScheduleRule` from `@opencroft/client/ui`. */
  type ScheduleRule,
  /** @deprecated Import `Schedules` from `@opencroft/client/ui`. */
  Schedules,
  /** @deprecated Import `SchedulesProps` from `@opencroft/client/ui`. */
  type SchedulesProps,
  /** @deprecated Import `ScheduleUnit` from `@opencroft/client/ui`. */
  type ScheduleUnit,
  /** @deprecated Import `ScrollArea` from `@opencroft/client/ui`. */
  ScrollArea,
  /** @deprecated Import `ScrollAreaScrollbars` from `@opencroft/client/ui`. */
  type ScrollAreaScrollbars,
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
  /** @deprecated Import `SimpleSchedule` from `@opencroft/client/ui`. */
  type SimpleSchedule,
  /** @deprecated Import `Skeleton` from `@opencroft/client/ui`. */
  Skeleton,
  /** @deprecated Import `Slider` from `@opencroft/client/ui`. */
  Slider,
  /** @deprecated Import `Spinner` from `@opencroft/client/ui`. */
  Spinner,
  /** @deprecated Import `StatusIndicator` from `@opencroft/client/ui`. */
  StatusIndicator,
  /** @deprecated Import `StatusIndicatorProps` from `@opencroft/client/ui`. */
  type StatusIndicatorProps,
  /** @deprecated Import `StatusVariant` from `@opencroft/client/ui`. */
  type StatusVariant,
  /** @deprecated Import `Switch` from `@opencroft/client/ui`. */
  Switch,
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
  /** @deprecated Import `TypingDotsProps` from `@opencroft/client/ui`. */
  type TypingDotsProps,
  /** @deprecated Import `tabsListVariants` from `@opencroft/client/ui`. */
  tabsListVariants,
  /** @deprecated Import `toggleVariants` from `@opencroft/client/ui`. */
  toggleVariants,
  /** @deprecated Import `UpcomingRun` from `@opencroft/client/ui`. */
  type UpcomingRun,
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
} from './ui'

import * as iconsNamespace from 'lucide-react'

export {
  /** @deprecated Use `import { toast } from 'sonner'`. */
  toast,
} from 'sonner'

export {
  /** @deprecated Use each icon by name from `lucide-react`. */
  iconsNamespace as icons,
}

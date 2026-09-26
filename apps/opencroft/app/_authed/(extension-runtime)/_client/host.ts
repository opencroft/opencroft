'use client'

import { Terminal } from '@opencroft/terminal/client'
import {
  Handle,
  NodeResizer,
  Position,
  useEdges,
  useNodeId,
  useNodes,
  useReactFlow,
  useUpdateNodeInternals,
} from '@xyflow/react'
import { CodeBlock } from 'agent-chat/components/code-block'
import { CodeBlockEditor } from 'agent-chat/components/code-block-editor'
import { Markdown, markdownDirectiveBlocks } from 'agent-chat/components/markdown'
import { MermaidDiagram } from 'agent-chat/components/mermaid-diagram'
import type * as icons from 'lucide-react'
import * as React from 'react'
import { createPortal } from 'react-dom'
import { toast } from 'sonner'
import * as uiKit from 'ui/ext'
import { useIsMobile } from 'ui/hooks/use-mobile'
import { TitleBarPortal, TitleBarTitle, TitleBarToolbar } from 'ui/layouts/title-bar'

import { AppLink, useAppHref, useAppLocation, useAppNavigate } from '@/app/_authed/(apps)/_components/app-router'
import { callAppActionFromUi } from '@/app/_authed/(apps)/_server/actions'
import { CommandBar, CommandBarMenu, CommandBarMenuItem } from '@/app/_authed/(dashboard)/_canvas/command-bar'
import { inspectorIntent, useInspectorIntent } from '@/app/_authed/(dashboard)/_canvas/inspector-intent'
import { NodeCard, NodeCardContent, NodeCardHeader } from '@/app/_authed/(dashboard)/_canvas/node-card'
import { NodeFrame, useNodeAccent } from '@/app/_authed/(dashboard)/_canvas/node-frame'
import { useOverlay } from '@/app/_authed/(dashboard)/_canvas/overlay-context'
import { useNodeContext } from '@/app/_authed/(dashboard)/_extension-system/use-node-context'
import { ChatDock } from '@/app/_authed/(extension-runtime)/_client/chat-dock'
import { ChatSelector } from '@/app/_authed/(extension-runtime)/_client/chat-selector'
import { EmbeddedAgentChat } from '@/app/_authed/(extension-runtime)/_client/embedded-agent-chat'
import { GraphCanvasLoading } from '@/app/_authed/(extension-runtime)/_client/graph-canvas-loading'
import { NodeRef } from '@/app/_authed/(extension-runtime)/_client/node-ref'
import { extensionRegistry } from '@/app/_authed/(extension-runtime)/_client/registry'
import { createSafeIcons } from '@/app/_authed/(extension-runtime)/_client/safe-icons'
import { SelectionProvider, useSelection } from '@/app/_authed/(extension-runtime)/_client/selection-context'
import {
  broadcast,
  getStream,
  type Stream,
  subscribe,
  type TextChunk,
} from '@/app/_authed/(extension-runtime)/_client/stream'
import { TerminalRef } from '@/app/_authed/(extension-runtime)/_client/terminal-ref'
import { TerminalSelector } from '@/app/_authed/(extension-runtime)/_client/terminal-selector'
import { invokeExtensionAction } from '@/app/_authed/(extension-runtime)/_server/actions'
import { dispatchNodeAction } from '@/app/_authed/(extension-runtime)/_server/node-actions'
import type { ExtensionContextType, ExtensionHandle } from '@/app/_authed/(extension-runtime)/_types'
import { FileBrowser } from '@/app/_authed/(filemanager)/_components/file-browser'
import { FileManagerProvider } from '@/app/_authed/(filemanager)/_components/filemanager-provider'
import { SecretSelector } from '@/app/_authed/(secrets-store)/_components/secret-selector'
import {
  useDockerContainers,
  useDockerSnapshotReceived,
  useSeedDockerContainers,
} from '@/app/_authed/(sse)/_lib/sse-events-store'
import { useUrlParam } from '@/app/_lib/use-url-param'
import { AppSidebar } from '@/app/_shell/app-sidebar'
import { CodeEditor } from '@/components/code-editor'
import { MarkdownEditor } from '@/components/markdown-editor'
import { ControlledInput } from '@/components/ui/input/controlled-input'

// What extension code actually receives as `icons` -- see safe-icons.ts for
// why this has to be the namespace's source, not something callers opt into.
const safeIcons = createSafeIcons()

export interface ExtensionComponentProps<D = Record<string, unknown>> {
  id: string
  data: D
  selected?: boolean
}

export interface ExtensionInspectorProps<D = Record<string, unknown>> {
  nodeId: string
  data: D
  updateData: (patch: Partial<D>) => void
}

export interface InspectorTab<D = Record<string, unknown>> {
  /** Unique tab id, used as the React key */
  id: string
  /** Tab label shown in the tab bar */
  label: string
  /** Icon name from lucide-react (optional) */
  icon?: string
  /** When true, the tab content fills the inspector body (for terminals, logs, etc.) instead of being wrapped in a scroll area. */
  fullHeight?: boolean
  /** Tab content component */
  component: React.ComponentType<ExtensionInspectorProps<D>>
}

/** Context passed to a node context-menu item's `isEnabled`/`onSelect`. */
export interface NodeContextMenuContext<D = Record<string, unknown>> {
  nodeId: string
  typeId: string
  data: D
}

export interface NodeContextMenuItem<D = Record<string, unknown>> {
  /** Unique item id, used as the React key */
  id: string
  /** Item label shown in the menu */
  label: string
  /** Icon name from lucide-react (optional) */
  icon?: string
  /** Styles the item as a destructive (red) action */
  destructive?: boolean
  /** Whether the item is selectable; omit to always enable. May be async (e.g. checking live node state). */
  isEnabled?: (ctx: NodeContextMenuContext<D>) => boolean | Promise<boolean>
  /** Invoked when the item is selected. */
  onSelect: (ctx: NodeContextMenuContext<D>) => void | Promise<void>
}

export interface NodeDefinition<D = Record<string, unknown>> {
  typeId: string
  name: string
  category?: string
  description?: string
  icon?: string
  accent?: string
  handles?: ExtensionHandle[]
  defaultData?: D
  component: React.ComponentType<ExtensionComponentProps<D>>
  inspector?: React.ComponentType<ExtensionInspectorProps<D>>
  /** Additional inspector tabs beyond the default "Details" tab */
  inspectorTabs?: InspectorTab<D>[]
  /** Entries this node type contributes to its right-click context menu, after the built-in Copy/Delete actions. */
  contextMenuItems?: NodeContextMenuItem<D>[]
  exposeOutput?: (handleId: string, data: D, typeId: string, nodeId: string) => unknown
}

export interface ExtensionDeclarationManifest {
  id: string
  name?: string
  version?: string
  description?: string
}

export interface CommandBarNode {
  id: string
  label: string
  subtitle: string
  data: Record<string, unknown>
  icon: icons.LucideIcon
  accent: string
}

export interface CommandModeProps {
  nodes: CommandBarNode[]
  spaceName: string
  selectedNodeId: string | null
  focusTick: number
  /** Params passed by the caller of activate(modeId, params); null when opened without any. */
  params: unknown
  onFocusNode: (nodeId: string) => void
  onClose: () => void
  onFocusChange: (focused: boolean) => void
}

export interface CommandModeShortcut {
  /**
   * A `KeyboardEvent.code` value — the physical key, not the character it
   * produces, so the shortcut fires the same way on every keyboard layout.
   * Held with Ctrl (or Cmd on macOS) plus whichever of `shift`/`alt` below are
   * set. Letters: `'KeyF'`. Digits: `'Digit1'`. Punctuation has its own names
   * (`'Comma'`, `'Period'`, `'Slash'`, `'Minus'`, ...) — never the character
   * itself, since on some layouts a digit or punctuation key needs a modifier
   * to type the character it is labelled with on a US keyboard.
   */
  code: string
  shift?: boolean
  alt?: boolean
}

export interface CommandModeDefinition {
  id: string
  label: string
  icon?: string
  description?: string
  shortcut?: CommandModeShortcut
  /** Render the overlay content across the full canvas width instead of the compact chat column. */
  fullWidth?: boolean
  component: React.ComponentType<CommandModeProps>
}

export interface SettingsPageDefinition {
  id: string
  label: string
  icon?: string
  component: React.ComponentType
}

export interface ExtensionDeclaration {
  manifest: ExtensionDeclarationManifest
  contexts?: ExtensionContextType[]
  nodes?: NodeDefinition[]
  commandModes?: CommandModeDefinition[]
  settings?: SettingsPageDefinition[]
  /** Generic, feature-defined provider points (e.g. `apps`). The runtime
   *  forwards these to the provider registry untouched. */
  provides?: Record<string, unknown[]>
}

export function defineExtension(decl: ExtensionDeclaration): ExtensionDeclaration {
  const nodes = decl.nodes ?? []
  const modes = decl.commandModes ?? []
  const settings = decl.settings ?? []
  const provides = decl.provides ?? {}
  const hasProvided = Object.values(provides).some((items) => items.length > 0)
  if (nodes.length === 0 && modes.length === 0 && settings.length === 0 && !hasProvided) {
    throw new Error(
      `Extension ${decl.manifest.id}: defineExtension requires at least one node, command mode, settings page, or provided entry`,
    )
  }
  return { ...decl, nodes, commandModes: modes, settings, provides }
}

// ── Node handle pins ───────────────────────────────────────────────────
// Generic Input / Output components that render an xyflow Handle on the
// node edge plus optional inline content (label, button, anything).

export interface HandlePinProps {
  type: string
  id?: string
  color?: string
  children?: React.ReactNode
}

function handlePinStyle(side: 'left' | 'right', color: string): React.CSSProperties {
  return {
    width: 10,
    height: 10,
    background: color,
    border: '2px solid var(--background)',
    [side === 'right' ? 'marginRight' : 'marginLeft']: '-5px',
  }
}

function useHandleDisconnect(handleId: string, role: 'source' | 'target') {
  const nodeId = useNodeId()
  const { getEdges, deleteElements } = useReactFlow()
  return React.useCallback(
    (e: React.MouseEvent) => {
      e.stopPropagation()
      e.preventDefault()
      if (!nodeId) {
        return
      }
      const matches = getEdges().filter((edge) => {
        if (role === 'source') {
          return edge.source === nodeId && edge.sourceHandle === handleId
        }
        return edge.target === nodeId && edge.targetHandle === handleId
      })
      if (matches.length === 0) {
        return
      }
      deleteElements({ edges: matches.map((edge) => ({ id: edge.id })) })
    },
    [nodeId, handleId, role, getEdges, deleteElements],
  )
}

export function OutputHandle({ type, id, color, children }: HandlePinProps) {
  const handleId = id ?? type
  const ctxColor = color ?? extensionRegistry.getContextType(type)?.color
  const fill = ctxColor ?? 'var(--primary)'
  const onDoubleClick = useHandleDisconnect(handleId, 'source')
  return React.createElement(
    'div',
    { className: 'flex items-center gap-1 justify-end -mr-4 min-h-5' },
    children,
    React.createElement(Handle, {
      type: 'source',
      position: Position.Right,
      id: handleId,
      className: 'inline-handle',
      style: handlePinStyle('right', fill),
      onDoubleClick,
    }),
  )
}

export function InputHandle({ type, id, color, children }: HandlePinProps) {
  const handleId = id ?? type
  const ctxColor = color ?? extensionRegistry.getContextType(type)?.color
  const fill = ctxColor ?? 'var(--primary)'
  const onDoubleClick = useHandleDisconnect(handleId, 'target')
  return React.createElement(
    'div',
    { className: 'flex items-center gap-1 justify-start -ml-4 min-h-5' },
    React.createElement(Handle, {
      type: 'target',
      position: Position.Left,
      id: handleId,
      className: 'inline-handle',
      style: handlePinStyle('left', fill),
      onDoubleClick,
    }),
    children,
  )
}

async function callAction(extensionId: string, actionName: string, args: unknown[]): Promise<unknown> {
  return invokeExtensionAction({ data: { extensionId, actionName, args } })
}

async function callNodeAction(nodeId: string, actionId: string, params?: Record<string, unknown>): Promise<unknown> {
  return dispatchNodeAction({ data: { nodeId, actionId, params: params ?? {} } })
}

async function callAppAction(instanceId: string, action: string, params?: Record<string, unknown>): Promise<unknown> {
  return callAppActionFromUi({ data: { instanceId, action, params: params ?? {} } })
}

export interface ExtensionStorage {
  get<T = unknown>(key: string): Promise<T | null>
  set<T = unknown>(key: string, value: T): Promise<void>
  delete(key: string): Promise<void>
  list(): Promise<string[]>
  clear(): Promise<void>
}

function createStorageFor(extensionId: string, namespace?: string): ExtensionStorage {
  const prefix = namespace ? `${namespace}::` : ''
  return {
    get: (key) => callAction(extensionId, '__storage_get', [prefix + key]) as Promise<never>,
    set: (key, value) => callAction(extensionId, '__storage_set', [prefix + key, value]) as Promise<void>,
    delete: (key) => callAction(extensionId, '__storage_delete', [prefix + key]) as Promise<void>,
    list: () => callAction(extensionId, '__storage_list', []) as Promise<string[]>,
    clear: () => callAction(extensionId, '__storage_clear', []) as Promise<void>,
  }
}

// ── The graph surface, reached lazily ──────────────────────────────────
// This module is what anything asks when it wants to know what the host
// offers: the extension compiler under bare `tsx`, the provider registry, and
// suites that never draw a canvas. Importing the graph surface STATICALLY put
// the whole editor subtree behind that question --
//   graph-canvas -> space-canvas -> flow-editor -> @xyflow/react's stylesheet
// -- so every consumer of the host API paid for the heaviest UI in the app,
// and any runtime without a CSS loader could not load this module at all.
// A dynamic import keeps the capability and drops the edge: the module
// arrives when something actually renders a graph. See
// host-import-graph.test.ts, which asserts the edge rather than the symptom.
//
// The Suspense boundary belongs here rather than at the call site, because
// the call site is a compiled extension bundle that receives GraphCanvas
// through the host API. A component handed out that way cannot also require
// whoever renders it to remember a boundary.
const LazyGraphCanvas = React.lazy(async () => ({
  default: (await import('@/app/_authed/(extension-runtime)/_client/graph-canvas')).GraphCanvas,
}))

function GraphCanvas(props: { instanceId: string }) {
  return React.createElement(
    React.Suspense,
    {
      // The same component the canvas shows while it resolves its own view, so
      // fetching the chunk and fetching the graph are one wait rather than two
      // that merely happen to match today.
      fallback: React.createElement(GraphCanvasLoading),
    },
    React.createElement(LazyGraphCanvas, props),
  )
}

export const extensionUiApi = {
  // Every component from the `ui` package (Badge, Button, Select, Dialog,
  // SearchableDropdown, Popover, Command, Combobox, …) — see `ui/ext`.
  ...uiKit,
  // App-provided components that live outside the `ui` package (or override it).
  //
  // The chat's code renderer, handed out rather than copied: the highlighter
  // behind it keeps one instance and one grammar cache for the page, so an
  // extension bundling its own would re-download grammars the chat already has.
  CodeBlock,
  // The same highlighter again, with a textarea over it. Handed out beside
  // `CodeEditor` rather than in place of it: this one costs nothing to appear,
  // so a surface can carry a dozen, where each `CodeEditor` is a Monaco mount.
  CodeBlockEditor,
  CodeEditor,
  ControlledInput,
  FileBrowser,
  FileManagerProvider,
  // The chat's markdown renderer -- fenced blocks through `CodeBlock`, mermaid
  // fences as diagrams. Shared for the highlighter reason above and for one
  // more: the `rel="noopener noreferrer"` it puts on every link is a security
  // property, and a second copy of the renderer loses it with no symptom.
  Markdown,
  // The documentation blocks that renderer draws (callouts, spoilers, tabs),
  // as remark plugins plus element renderers, for a surface whose own
  // `react-markdown` it cannot replace. Shared so those blocks look and parse
  // exactly as they do in `Markdown`, and so `MarkdownEditor` below writes
  // nothing such a surface shows as raw `:::`.
  markdownDirectiveBlocks,
  // The other end of that renderer: the product's one markdown WYSIWYG, which
  // both the skills editor and the documentation extension's page editor now
  // are. Shared because TipTap is a large dependency to bundle per extension,
  // and because an extension's own editor drifts into its own markdown dialect
  // -- what this writes has to be what `Markdown` above renders. It comes in
  // through `@/components/markdown-editor`, which defers the module: this
  // object is built wherever the host surface is asked for, and most of those
  // places never edit anything.
  MarkdownEditor,
  // What `Markdown` already renders a `mermaid` fence with, exposed on its own
  // for a surface holding diagram source that never was markdown. Shared
  // because mermaid is a megabyte-class dependency fetched on first use, and
  // because the host's copy is pinned to `securityLevel: 'strict'`.
  MermaidDiagram,
  // Ids shown by name: a node / App instance, and a "node-id/handle-id"
  // terminal target. Host components because they read the graph.
  NodeRef,
  SecretSelector,
  Terminal,
  TerminalRef,
  TerminalSelector,
  // Pre-@opencroft/terminal name for already-compiled extensions.
  InspectorTerminalBody: Terminal,
  CommandBar,
  CommandBarMenu,
  CommandBarMenuItem,
  // An App's own pages as real paths under its instance's address — see
  // app-router. Host-owned because they read the host's router.
  AppLink,
  useAppHref,
  useAppLocation,
  useAppNavigate,
  // An App's heading, actions and tools in the shell's title bar, and its
  // panels in the shell's sidebar, sent there by portal from where the App
  // renders them. They must be the shell's own components: a copy would hold
  // its own context and reach no bar.
  AppTitle: TitleBarTitle,
  AppActions: TitleBarPortal,
  AppToolbar: TitleBarToolbar,
  AppSidebar,
}

export const extensionHostApi = {
  React,
  defineExtension,
  NodeFrame,
  useNodeAccent,
  NodeCard,
  NodeCardHeader,
  NodeCardContent,
  NodeResizer,
  InputHandle,
  OutputHandle,
  useNodeContext,
  inspectorIntent,
  useInspectorIntent,
  useOverlay,
  useUrlParam,
  useGraphNodes: useNodes,
  useGraphEdges: useEdges,
  useReactFlow,
  useUpdateNodeInternals,
  Handle,
  Position,
  callAction,
  callNodeAction,
  // An App instance's own actions, run as the signed-in person — see
  // `callAppActionFromUi`.
  callAppAction,
  createStorage: createStorageFor,
  createPortal,
  icons: safeIcons,
  toast,
  getStream,
  subscribe,
  broadcast,
  useDockerContainers,
  useDockerSnapshotReceived,
  useSeedDockerContainers,
  // The embeddable group-chat thread (props: `space` group-chat slug, `id`
  // default thread slug, optional `thread` selection override), the header
  // control that picks which conversation it shows, and the scoped selection
  // its composer reads — see embedded-agent-chat.tsx, chat-selector.tsx and
  // selection-context.tsx.
  EmbeddedAgentChat,
  ChatSelector,
  SelectionProvider,
  useSelection,
  // The whole chat surface around the embedded thread: the corner launcher,
  // the three docks plus the floating window, the mobile cover and its Back
  // behaviour — one component shared with the space canvas, so an extension
  // mounts this instead of arranging the pieces itself. See chat-dock.tsx.
  ChatDock,
  // The full canvas surface behind a Graph App instance (prop: `instanceId`)
  // — the builtin extension's Graph App component renders this and nothing
  // else. See graph-canvas.tsx.
  GraphCanvas,
  // The kit's mobile-breakpoint hook, so an extension chat dock can swap its
  // side-by-side arrangement for the full-screen cover on a small screen —
  // the same signal the space's own chat dock reads.
  useIsMobile,
}

export type { Stream, TextChunk }

export type ExtensionHostApi = typeof extensionHostApi

interface ExtensionGlobalApi {
  host: ExtensionHostApi
  ui: typeof extensionUiApi
}

export function installClientHost(): void {
  if (typeof window === 'undefined') {
    return
  }
  const win = window as unknown as { __extHost?: ExtensionGlobalApi }
  win.__extHost = {
    host: extensionHostApi,
    ui: extensionUiApi,
  }
}

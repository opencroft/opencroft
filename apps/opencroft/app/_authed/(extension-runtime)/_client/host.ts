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
import type * as icons from 'lucide-react'
import * as React from 'react'
import { createPortal } from 'react-dom'
import { toast } from 'sonner'
import * as uiKit from 'ui/ext'

import { CommandBar, CommandBarMenu, CommandBarMenuItem } from '@/app/_authed/(dashboard)/_canvas/command-bar'
import { inspectorIntent, useInspectorIntent } from '@/app/_authed/(dashboard)/_canvas/inspector-intent'
import { NodeCard, NodeCardContent, NodeCardHeader } from '@/app/_authed/(dashboard)/_canvas/node-card'
import { NodeFrame, useNodeAccent } from '@/app/_authed/(dashboard)/_canvas/node-frame'
import { useOverlay } from '@/app/_authed/(dashboard)/_canvas/overlay-context'
import { useNodeContext } from '@/app/_authed/(dashboard)/_extension-system/use-node-context'
import { extensionRegistry } from '@/app/_authed/(extension-runtime)/_client/registry'
import { createSafeIcons } from '@/app/_authed/(extension-runtime)/_client/safe-icons'
import {
  broadcast,
  getStream,
  type Stream,
  subscribe,
  type TextChunk,
} from '@/app/_authed/(extension-runtime)/_client/stream'
import { invokeExtensionAction } from '@/app/_authed/(extension-runtime)/_server/actions'
import { dispatchNodeAction } from '@/app/_authed/(extension-runtime)/_server/node-actions'
import type { ExtensionContextType, ExtensionHandle } from '@/app/_authed/(extension-runtime)/_types'
import { FileBrowser } from '@/app/_authed/(filemanager)/_components/file-browser'
import { FileManagerProvider } from '@/app/_authed/(filemanager)/_components/filemanager-provider'
import {
  useDockerContainers,
  useDockerSnapshotReceived,
  useSeedDockerContainers,
} from '@/app/_authed/(sse)/_lib/sse-events-store'
import { useUrlParam } from '@/app/_lib/use-url-param'
import { CodeEditor } from '@/components/code-editor'
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
  /** Generic, feature-defined provider points (e.g. `dashboards`). The runtime
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

export const extensionUiApi = {
  // Every component from the `ui` package (Badge, Button, Select, Dialog,
  // SearchableDropdown, Popover, Command, Combobox, …) — see `ui/ext`.
  ...uiKit,
  // App-provided components that live outside the `ui` package (or override it).
  CodeEditor,
  ControlledInput,
  FileBrowser,
  FileManagerProvider,
  Terminal,
  // Pre-@opencroft/terminal name for already-compiled extensions.
  InspectorTerminalBody: Terminal,
  CommandBar,
  CommandBarMenu,
  CommandBarMenuItem,
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

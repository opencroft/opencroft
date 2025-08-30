'use client';

import { Handle, NodeResizer, Position, useEdges, useNodeId, useNodes, useReactFlow, useUpdateNodeInternals } from '@xyflow/react';
import * as icons from 'lucide-react';
import * as React from 'react';
import { createPortal } from 'react-dom';
import { toast } from 'sonner';

import { CommandBar, CommandBarMenu, CommandBarMenuItem } from '@/app/(dashboard)/_canvas/command-bar';
import { inspectorIntent, useInspectorIntent } from '@/app/(dashboard)/_canvas/inspector-intent';
import { NodeCard, NodeCardContent, NodeCardHeader } from '@/app/(dashboard)/_canvas/node-card';
import { NodeFrame, useNodeAccent } from '@/app/(dashboard)/_canvas/node-frame';
import { useOverlayBar, useOverlayContent, useOverlayMenu } from '@/app/(dashboard)/_canvas/overlay-context';
import { useNodeContext } from '@/app/(dashboard)/extension-system/use-node-context';
import { extensionRegistry } from '@/app/(extension-runtime)/_client/registry';
import {
  type AudioChunk,
  broadcast,
  getStream,
  type Stream,
  subscribe,
  type TextChunk,
} from '@/app/(extension-runtime)/_client/stream';
import { invokeExtensionAction } from '@/app/(extension-runtime)/_server/actions';
import { dispatchNodeAction } from '@/app/(extension-runtime)/_server/node-actions';
import { type ExtensionContextType, type ExtensionHandle } from '@/app/(extension-runtime)/_types';
import { FileBrowser } from '@/app/(filemanager)/files/file-browser';
import { FileManagerProvider } from '@/app/(filemanager)/files/filemanager-provider';
import { useDockerContainers, useDockerSnapshotReceived, useSeedDockerContainers } from '@/app/(sse)/stores/sse-events-store';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { ChatInput } from '@/components/ui/chat/chat-input';
import { ChatMessage } from '@/components/ui/chat/chat-message';
import {
  Dialog,
  DialogClose,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from '@/components/ui/dialog';
import { Input as TextInput } from '@/components/ui/input';
import { ControlledInput } from '@/components/ui/input/controlled-input';
import { Label } from '@/components/ui/label';
import { Flex } from '@/components/ui/layout/flex';
import { ScrollArea } from '@/components/ui/layout/scroll-area';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import { Separator } from '@/components/ui/separator';
import { Slider } from '@/components/ui/slider';
import { Textarea } from '@/components/ui/textarea';
import { StatusIndicator } from '@/components/ui/utils/status-indicator';

export interface ExtensionComponentProps<D = Record<string, unknown>> {
  id: string;
  data: D;
  selected?: boolean;
}

export interface ExtensionInspectorProps<D = Record<string, unknown>> {
  nodeId: string;
  data: D;
  updateData: (patch: Partial<D>) => void;
}

export interface InspectorTab<D = Record<string, unknown>> {
  /** Unique tab id, used as the React key */
  id: string;
  /** Tab label shown in the tab bar */
  label: string;
  /** Icon name from lucide-react (optional) */
  icon?: string;
  /** When true, the tab content fills the inspector body (for terminals, logs, etc.) instead of being wrapped in a scroll area. */
  fullHeight?: boolean;
  /** Tab content component */
  component: React.ComponentType<ExtensionInspectorProps<D>>;
}

export interface NodeDefinition<D = Record<string, unknown>> {
  typeId: string;
  name: string;
  category?: string;
  description?: string;
  icon?: string;
  accent?: string;
  handles?: ExtensionHandle[];
  defaultData?: D;
  component: React.ComponentType<ExtensionComponentProps<D>>;
  inspector?: React.ComponentType<ExtensionInspectorProps<D>>;
  /** Additional inspector tabs beyond the default "Details" tab */
  inspectorTabs?: InspectorTab<D>[];
  exposeOutput?: (handleId: string, data: D, typeId: string, nodeId: string) => unknown;
}

export interface ExtensionDeclarationManifest {
  id: string;
  name?: string;
  version?: string;
  description?: string;
}

export interface CommandBarNode {
  id: string;
  label: string;
  subtitle: string;
  data: Record<string, unknown>;
  icon: icons.LucideIcon;
  accent: string;
}

export interface CommandModeProps {
  nodes: CommandBarNode[];
  spaceName: string;
  selectedNodeId: string | null;
  focusTick: number;
  onFocusNode: (nodeId: string) => void;
  onClose: () => void;
  onFocusChange: (focused: boolean) => void;
}

export interface CommandModeShortcut {
  key: string;
  shift?: boolean;
  alt?: boolean;
}

export interface CommandModeDefinition {
  id: string;
  label: string;
  icon?: string;
  description?: string;
  shortcut?: CommandModeShortcut;
  component: React.ComponentType<CommandModeProps>;
}

export interface SettingsPageDefinition {
  id: string;
  label: string;
  icon?: string;
  component: React.ComponentType;
}

export interface ExtensionDeclaration {
  manifest: ExtensionDeclarationManifest;
  contexts?: ExtensionContextType[];
  nodes?: NodeDefinition[];
  commandModes?: CommandModeDefinition[];
  settings?: SettingsPageDefinition[];
}

export function defineExtension(decl: ExtensionDeclaration): ExtensionDeclaration {
  const nodes = decl.nodes ?? [];
  const modes = decl.commandModes ?? [];
  const settings = decl.settings ?? [];
  if (nodes.length === 0 && modes.length === 0 && settings.length === 0) {
    throw new Error(`Extension ${decl.manifest.id}: defineExtension requires at least one node, command mode, or settings page`);
  }
  return { ...decl, nodes, commandModes: modes, settings };
}

// ── Node handle pins ───────────────────────────────────────────────────
// Generic Input / Output components that render an xyflow Handle on the
// node edge plus optional inline content (label, button, anything).

export interface HandlePinProps {
  type: string;
  id?: string;
  color?: string;
  children?: React.ReactNode;
}

function handlePinStyle(side: 'left' | 'right', color: string): React.CSSProperties {
  return {
    width: 10,
    height: 10,
    background: color,
    border: '2px solid var(--background)',
    [side === 'right' ? 'marginRight' : 'marginLeft']: '-5px',
  };
}

function useHandleDisconnect(handleId: string, role: 'source' | 'target') {
  const nodeId = useNodeId();
  const { getEdges, deleteElements } = useReactFlow();
  return React.useCallback((e: React.MouseEvent) => {
    e.stopPropagation();
    e.preventDefault();
    if (!nodeId) {
      return;
    }
    const matches = getEdges().filter((edge) => {
      if (role === 'source') {
        return edge.source === nodeId && edge.sourceHandle === handleId;
      }
      return edge.target === nodeId && edge.targetHandle === handleId;
    });
    if (matches.length === 0) {
      return;
    }
    deleteElements({ edges: matches.map((edge) => ({ id: edge.id })) });
  }, [nodeId, handleId, role, getEdges, deleteElements]);
}

export function OutputHandle({ type, id, color, children }: HandlePinProps) {
  const handleId = id ?? type;
  const ctxColor = color ?? extensionRegistry.getContextType(type)?.color;
  const fill = ctxColor ?? 'var(--primary)';
  const onDoubleClick = useHandleDisconnect(handleId, 'source');
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
  );
}

export function InputHandle({ type, id, color, children }: HandlePinProps) {
  const handleId = id ?? type;
  const ctxColor = color ?? extensionRegistry.getContextType(type)?.color;
  const fill = ctxColor ?? 'var(--primary)';
  const onDoubleClick = useHandleDisconnect(handleId, 'target');
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
  );
}

async function callAction(extensionId: string, actionName: string, args: unknown[]): Promise<unknown> {
  return invokeExtensionAction(extensionId, actionName, args);
}

async function callNodeAction(nodeId: string, actionId: string, params?: Record<string, unknown>): Promise<unknown> {
  return dispatchNodeAction(nodeId, actionId, params ?? {});
}

export interface ExtensionStorage {
  get<T = unknown>(key: string): Promise<T | null>;
  set<T = unknown>(key: string, value: T): Promise<void>;
  delete(key: string): Promise<void>;
  list(): Promise<string[]>;
  clear(): Promise<void>;
}

function createStorageFor(extensionId: string, namespace?: string): ExtensionStorage {
  const prefix = namespace ? `${namespace}::` : '';
  return {
    get: (key) => callAction(extensionId, '__storage_get', [prefix + key]) as Promise<never>,
    set: (key, value) => callAction(extensionId, '__storage_set', [prefix + key, value]) as Promise<void>,
    delete: (key) => callAction(extensionId, '__storage_delete', [prefix + key]) as Promise<void>,
    list: () => callAction(extensionId, '__storage_list', []) as Promise<string[]>,
    clear: () => callAction(extensionId, '__storage_clear', []) as Promise<void>,
  };
}

export const extensionUiApi = {
  Badge,
  Button,
  Input: TextInput,
  ControlledInput,
  Label,
  Flex,
  ScrollArea,
  Select,
  SelectTrigger,
  SelectContent,
  SelectItem,
  SelectValue,
  Separator,
  Textarea,
  ChatMessage,
  ChatInput,
  Slider,
  StatusIndicator,
  Dialog,
  DialogClose,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
  FileBrowser,
  FileManagerProvider,
  CommandBar,
  CommandBarMenu,
  CommandBarMenuItem,
};

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
  useOverlayBar,
  useOverlayMenu,
  useOverlayContent,
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
  icons,
  toast,
  getStream,
  subscribe,
  broadcast,
  useDockerContainers,
  useDockerSnapshotReceived,
  useSeedDockerContainers,
};

export type { AudioChunk, Stream, TextChunk };

export type ExtensionHostApi = typeof extensionHostApi;

interface ExtensionGlobalApi {
  host: ExtensionHostApi;
  ui: typeof extensionUiApi;
}

export function installClientHost(): void {
  if (typeof window === 'undefined') {
    return;
  }
  const win = window as unknown as { __extHost?: ExtensionGlobalApi };
  win.__extHost = {
    host: extensionHostApi,
    ui: extensionUiApi,
  };
}

'use client'

import type { ValueOption } from '@opencroft/core/values'
import { Box, type LucideIcon } from 'lucide-react'
import type { ComponentType } from 'react'
import { iconComponent } from 'ui/media/named-icon'

import type {
  CommandModeDefinition,
  ExtensionComponentProps,
  ExtensionInspectorProps,
  LoadedExtensionDeclaration,
  LoadedNodeDefinition,
  NodeContextMenuItem,
  SettingsPageDefinition,
} from '@/app/_authed/(extension-runtime)/_client/host'
import { providerRegistry } from '@/app/_authed/(extension-runtime)/_client/provides'
import { isLocalFolder, parseType } from '@/app/_authed/(extension-runtime)/_extension-id'
import type { ExtensionHandle, ExtensionHandleType, ResolvedContext } from '@/app/_authed/(extension-runtime)/_types'

/**
 * The icon a declaration names, as a component; `fallback` (Box unless given)
 * for no name or one Lucide doesn't have. Loaded on first use -- the loader
 * preloads every name a declaration carries before registering it, so the
 * surfaces that draw them never wait (see `declaredIconNames`).
 */
export function resolveIcon(name?: string, fallback: LucideIcon = Box): LucideIcon {
  return name ? iconComponent(name, fallback) : fallback
}

/** Flat view of a single node — what consumer components need. */
export interface ResolvedNode {
  /** The extension that owns this node. */
  extension: LoadedExtensionDeclaration
  /** Index into extension.nodes. */
  nodeIndex: number
  /** The qualified type graphs store. */
  type: string
  name: string
  category?: string
  description?: string
  icon: LucideIcon
  accent: string
  handles: ExtensionHandle[]
  defaultData: Record<string, unknown>
  component: ComponentType<ExtensionComponentProps>
  inspector?: ComponentType<ExtensionInspectorProps>
  inspectorFullHeight?: boolean

  inspectorTabs?: Array<{
    id: string
    label: string
    icon?: string
    fullHeight?: boolean
    keepMounted?: boolean
    component: ComponentType<ExtensionInspectorProps>
  }>

  contextMenuItems?: NodeContextMenuItem[]

  /** The declaring extension's `exposeOutput`, already told the node's bare type. */
  exposeOutput?: (
    handleId: string,
    data: Record<string, unknown>,
    nodeId: string,
    contexts: Record<string, ResolvedContext>,
  ) => unknown

  /** The declaring extension's canvas-derived errors (see `NodeDefinition.errors`). */
  errors?: LoadedNodeDefinition['errors']
}

/**
 * The folder to open in the extension editor for a node's extension, or null
 * when the extension is not editable here. Only a local folder is: any other
 * is a copy of a repository that an update replaces.
 */
export function editableFolderOf(node: ResolvedNode): string | null {
  const folder = node.extension.manifest.folder
  return folder !== undefined && isLocalFolder(folder) ? folder : null
}

export interface ResolvedExtensionSettings {
  extensionId: string
  extensionName: string
  pages: SettingsPageDefinition[]
}

// Every type a loaded declaration carries is already qualified with the id the
// server gave its extension (see loaded-declaration.ts), so two extensions
// declaring one bare name file under two keys here and neither displaces the
// other.
class ExtensionRegistry {
  private byExtensionId = new Map<string, LoadedExtensionDeclaration>()
  private byType = new Map<string, { extension: LoadedExtensionDeclaration; nodeIndex: number }>()
  private handleTypes = new Map<string, ExtensionHandleType>()
  private commandModes = new Map<string, CommandModeDefinition>()

  register(decl: LoadedExtensionDeclaration): void {
    this.byExtensionId.set(decl.manifest.id, decl)
    ;(decl.nodes ?? []).forEach((node, nodeIndex) => {
      this.byType.set(node.type, { extension: decl, nodeIndex })
    })
    for (const handleType of decl.handleTypes ?? []) {
      this.handleTypes.set(handleType.id, handleType)
    }
    for (const mode of decl.commandModes ?? []) {
      this.commandModes.set(mode.id, mode)
    }
    providerRegistry.register(decl.manifest.id, decl.provides ?? {})
  }

  allCommandModes(): CommandModeDefinition[] {
    return Array.from(this.commandModes.values())
  }

  allSettings(): ResolvedExtensionSettings[] {
    const result: ResolvedExtensionSettings[] = []
    for (const decl of this.byExtensionId.values()) {
      const pages = decl.settings ?? []
      if (pages.length === 0) {
        continue
      }
      result.push({
        extensionId: decl.manifest.id,
        extensionName: decl.manifest.name ?? decl.manifest.id,
        pages,
      })
    }
    return result
  }

  /** Returns a fully resolved node entry with icon, defaults, etc., for a qualified type. */
  resolveNode(type: string): ResolvedNode | undefined {
    const entry = this.byType.get(type)
    if (!entry) {
      return undefined
    }
    const node = entry.extension.nodes?.[entry.nodeIndex]
    const bare = parseType(type)?.bare
    if (!node || !bare) {
      return undefined
    }
    const { exposeOutput } = node
    return {
      extension: entry.extension,
      nodeIndex: entry.nodeIndex,
      type: node.type,
      name: node.name,
      category: node.category,
      description: node.description,
      icon: resolveIcon(node.icon),
      accent: node.accent ?? 'oklch(0.7 0.17 200)',
      handles: node.handles ?? [],
      defaultData: { ...((node.defaultData as Record<string, unknown>) ?? {}) },
      component: node.component,
      inspector: node.inspector,
      inspectorFullHeight: node.inspectorFullHeight,
      inspectorTabs: node.inspectorTabs,
      contextMenuItems: node.contextMenuItems,
      exposeOutput:
        exposeOutput && ((handleId, data, nodeId, contexts) => exposeOutput(handleId, data, bare, nodeId, contexts)),
      errors: node.errors,
    }
  }

  /** Returns all nodes across all extensions, fully resolved. */
  allNodes(): ResolvedNode[] {
    const result: ResolvedNode[] = []
    for (const [type] of this.byType) {
      const resolved = this.resolveNode(type)
      if (resolved) {
        result.push(resolved)
      }
    }
    return result
  }

  getById(extensionId: string): LoadedExtensionDeclaration | undefined {
    return this.byExtensionId.get(extensionId)
  }

  all(): LoadedExtensionDeclaration[] {
    return Array.from(this.byExtensionId.values())
  }

  /** A declared handle type by its qualified id. */
  getHandleType(id: string): ExtensionHandleType | undefined {
    return this.handleTypes.get(id)
  }

  /** Every declared enum: each handle type that declares `cases`. */
  enumHandleTypes(): ExtensionHandleType[] {
    return [...this.handleTypes.values()].filter((handleType) => Array.isArray(handleType.cases))
  }

  /** The cases of a declared enum, by its qualified id (`EnumCasesOf`); bound, so it can be passed on. */
  enumCasesOf = (type: string): readonly ValueOption[] | undefined => this.handleTypes.get(type)?.cases

  clear(): void {
    this.byExtensionId.clear()
    this.byType.clear()
    this.handleTypes.clear()
    this.commandModes.clear()
    providerRegistry.clear()
  }
}

export const extensionRegistry = new ExtensionRegistry()

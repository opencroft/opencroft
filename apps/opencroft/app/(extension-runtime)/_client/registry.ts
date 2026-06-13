'use client'

import * as lucideIcons from 'lucide-react'
import type { ComponentType } from 'react'

import type {
  CommandModeDefinition,
  ExtensionDeclaration,
  SettingsPageDefinition,
} from '@/app/(extension-runtime)/_client/host'
import type { ExtensionContextType, ExtensionHandle } from '@/app/(extension-runtime)/_types'

/** Resolved icon: LucideIcon component or fallback Box. */
export function resolveIcon(name?: string): lucideIcons.LucideIcon {
  if (!name) {
    return lucideIcons.Box
  }
  return (lucideIcons as unknown as Record<string, lucideIcons.LucideIcon>)[name] ?? lucideIcons.Box
}

/** Flat view of a single node — what consumer components need. */
export interface ResolvedNode {
  /** The extension that owns this node. */
  extension: ExtensionDeclaration
  /** Index into extension.nodes. */
  nodeIndex: number
  typeId: string
  name: string
  category?: string
  description?: string
  icon: lucideIcons.LucideIcon
  accent: string
  handles: ExtensionHandle[]
  defaultData: Record<string, unknown>
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  component: ComponentType<any>
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  inspector?: ComponentType<any>

  inspectorTabs?: Array<{
    id: string
    label: string
    icon?: string
    fullHeight?: boolean
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    component: ComponentType<any>
  }>

  exposeOutput?: (handleId: string, data: Record<string, unknown>, typeId: string, nodeId: string) => unknown
}

export interface ResolvedExtensionSettings {
  extensionId: string
  extensionName: string
  pages: SettingsPageDefinition[]
}

class ExtensionRegistry {
  private byExtensionId = new Map<string, ExtensionDeclaration>()
  private byTypeId = new Map<string, { extension: ExtensionDeclaration; nodeIndex: number }>()
  private contextTypes = new Map<string, ExtensionContextType>()
  private commandModes = new Map<string, CommandModeDefinition>()

  register(decl: ExtensionDeclaration): void {
    this.byExtensionId.set(decl.manifest.id, decl)
    ;(decl.nodes ?? []).forEach((node, nodeIndex) => {
      this.byTypeId.set(node.typeId, { extension: decl, nodeIndex })
    })
    for (const ctx of decl.contexts ?? []) {
      this.contextTypes.set(ctx.id, ctx)
    }
    for (const mode of decl.commandModes ?? []) {
      this.commandModes.set(mode.id, mode)
    }
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

  getByTypeId(typeId: string): { extension: ExtensionDeclaration; nodeIndex: number } | undefined {
    return this.byTypeId.get(typeId)
  }

  /** Returns a fully resolved node entry with icon, defaults, etc. */
  resolveNode(typeId: string): ResolvedNode | undefined {
    const entry = this.byTypeId.get(typeId)
    if (!entry) {
      return undefined
    }
    const node = entry.extension.nodes?.[entry.nodeIndex]
    if (!node) {
      return undefined
    }
    return {
      extension: entry.extension,
      nodeIndex: entry.nodeIndex,
      typeId: node.typeId,
      name: node.name,
      category: node.category,
      description: node.description,
      icon: resolveIcon(node.icon),
      accent: node.accent ?? 'oklch(0.7 0.17 200)',
      handles: node.handles ?? [],
      defaultData: { ...((node.defaultData as Record<string, unknown>) ?? {}) },
      component: node.component,
      inspector: node.inspector,
      inspectorTabs: node.inspectorTabs,
      exposeOutput: node.exposeOutput,
    }
  }

  /** Returns all nodes across all extensions, fully resolved. */
  allNodes(): ResolvedNode[] {
    const result: ResolvedNode[] = []
    for (const [typeId] of this.byTypeId) {
      const resolved = this.resolveNode(typeId)
      if (resolved) {
        result.push(resolved)
      }
    }
    return result
  }

  getById(extensionId: string): ExtensionDeclaration | undefined {
    return this.byExtensionId.get(extensionId)
  }

  all(): ExtensionDeclaration[] {
    return Array.from(this.byExtensionId.values())
  }

  getContextType(id: string): ExtensionContextType | undefined {
    return this.contextTypes.get(id)
  }

  allContextTypes(): ExtensionContextType[] {
    return Array.from(this.contextTypes.values())
  }

  clear(): void {
    this.byExtensionId.clear()
    this.byTypeId.clear()
    this.contextTypes.clear()
    this.commandModes.clear()
  }
}

export const extensionRegistry = new ExtensionRegistry()

import type { Node, NodeProps, NodeTypes } from '@xyflow/react'
import type { LucideIcon } from 'lucide-react'
import type { ComponentType } from 'react'

export interface NodeSettingsProps<T extends Record<string, unknown> = Record<string, unknown>> {
  id: string
  data: T
  updateData: (data: Partial<T>) => void
  onDirtyChange: (dirty: boolean, save: () => void | Promise<void>) => void
  onLoadingChange: (loading: boolean) => void
}

export interface NodeTypeDefinition<T extends Record<string, unknown> = Record<string, unknown>> {
  type: string
  label: string
  icon: LucideIcon
  group: string
  defaultData: () => T
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  component: ComponentType<NodeProps<any>>
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  settings: ComponentType<NodeSettingsProps<any>>
}

// Infer AppNode union from definitions array
type InferNode<D> =
  D extends NodeTypeDefinition<infer T> ? Node<T, D extends { type: infer U } ? U & string : string> : never
export type InferNodeUnion<Defs extends readonly NodeTypeDefinition[]> = InferNode<Defs[number]>

export function buildNodeTypes(defs: readonly NodeTypeDefinition[]): NodeTypes {
  const types: NodeTypes = {}
  for (const def of defs) {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    types[def.type] = def.component as any
  }
  return types
}

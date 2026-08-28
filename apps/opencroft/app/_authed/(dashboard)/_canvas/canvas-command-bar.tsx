import type { LucideIcon } from 'lucide-react'

export type CommandMode = string

/**
 * The overlay at rest: no mode active, nothing painted over the canvas.
 *
 * Empty rather than a word, because a mode id is otherwise an extension's to
 * choose — any name reserved here could be taken by an extension and collide,
 * and no extension can declare the empty id.
 */
export const NO_COMMAND_MODE: CommandMode = ''

export interface CommandNodeEntry {
  id: string
  label: string
  subtitle: string
  data: Record<string, unknown>
  icon: LucideIcon
  accent: string
}

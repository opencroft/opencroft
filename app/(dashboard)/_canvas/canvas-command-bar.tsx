import { type LucideIcon } from 'lucide-react';

export type CommandMode = string;

export interface CommandNodeEntry {
  id: string;
  label: string;
  subtitle: string;
  data: Record<string, unknown>;
  icon: LucideIcon;
  accent: string;
}

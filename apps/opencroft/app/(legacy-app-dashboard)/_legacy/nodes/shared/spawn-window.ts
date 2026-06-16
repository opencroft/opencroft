import type { TerminalConfig } from '@opencroft/terminal'
import type { Node } from '@xyflow/react'

import type { StorageConnection } from '@/app/(filemanager)/_lib/types'

interface SpawnOptions {
  title: string
  x: number
  y: number
}

export function spawnTerminalWindow({ title, x, y }: SpawnOptions, termConfig: TerminalConfig): Node {
  return {
    id: crypto.randomUUID(),
    type: 'window',
    position: { x: x + 250, y },
    data: { title: `${title} — Terminal`, component: 'terminal', props: { termConfig } },
    style: { width: 600, height: 400 },
  }
}

export function spawnFileBrowserWindow({ title, x, y }: SpawnOptions, connection: StorageConnection): Node {
  return {
    id: crypto.randomUUID(),
    type: 'window',
    position: { x: x + 250, y },
    data: { title: `${title} — Files`, component: 'fileBrowser', props: { connection } },
    style: { width: 600, height: 400 },
  }
}

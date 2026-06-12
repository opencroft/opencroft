import { readFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'

import type { AgentSelection } from './types'

const CONFIG_PATH = join(process.cwd(), 'agent-config.json')

export const DEFAULT_SELECTION: AgentSelection = {
  providerId: 'zai',
  adapterId: 'claude',
  model: 'glm-4.6',
  apiKey: '',
  cwd: process.cwd(),
}

export async function readSelection(): Promise<AgentSelection> {
  try {
    const raw = await readFile(CONFIG_PATH, 'utf8')
    return {
      ...DEFAULT_SELECTION,
      ...(JSON.parse(raw) as Partial<AgentSelection>),
    }
  } catch {
    return DEFAULT_SELECTION
  }
}

export async function writeSelection(selection: AgentSelection): Promise<void> {
  await writeFile(CONFIG_PATH, `${JSON.stringify(selection, null, 2)}\n`, 'utf8')
}

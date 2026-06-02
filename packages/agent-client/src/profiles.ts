import type { AgentSelection } from './types'

// Client-safe module: pure data/types, no node:* imports, so it can be
// imported in the browser via "@demo/agent-client/profiles".

export interface AgentProfile {
  id: string // stable slug
  name: string // display label
  selection: AgentSelection // providerId / adapterId / model / apiKey / cwd
  mcpServerIds?: string[] // optional subset of mcp-config servers
  defaultModeId?: string // initial approval mode
}

export interface ProfilesFile {
  profiles: AgentProfile[]
  activeProfileId: string
}

// Default = today's behavior (the "claude-zai" profile mirrors DEFAULT_SELECTION
// in ./config exactly, so current behavior is the default profile).
export const DEFAULT_PROFILES: AgentProfile[] = [
  {
    id: 'claude-zai',
    name: 'Claude · z.ai GLM',
    selection: {
      providerId: 'zai',
      adapterId: 'claude',
      model: 'glm-4.6',
      apiKey: '',
      cwd: '/app',
    },
    defaultModeId: 'default',
  },
  {
    id: 'codex-openai',
    name: 'Codex · OpenAI',
    selection: {
      providerId: 'openai',
      adapterId: 'codex',
      model: 'gpt-5-codex',
      apiKey: '',
      cwd: '/app',
    },
  },
  {
    id: 'gemini',
    name: 'Gemini CLI',
    selection: {
      providerId: 'google',
      adapterId: 'gemini',
      model: 'gemini-2.5-pro',
      apiKey: '',
      cwd: '/app',
    },
  },
]

export const DEFAULT_ACTIVE_PROFILE_ID = 'claude-zai'

export function defaultProfile(): AgentProfile {
  return DEFAULT_PROFILES.find((p) => p.id === DEFAULT_ACTIVE_PROFILE_ID) ?? DEFAULT_PROFILES[0]
}

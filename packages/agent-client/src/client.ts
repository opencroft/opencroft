import type { McpCheckResult } from './mcp-check'
import type { McpServerConfig } from './mcp-types'
import type { AgentProfile, ProfilesFile } from './profiles'
import type { AgentSelection, SessionMeta } from './types'

const JSON_HEADERS = { 'content-type': 'application/json' }

export async function fetchSessions(): Promise<SessionMeta[]> {
  const response = await fetch('/api/acp/sessions')
  return response.json()
}

export async function createSession(profileId?: string): Promise<SessionMeta> {
  const response = await fetch('/api/acp/sessions', {
    method: 'POST',
    headers: JSON_HEADERS,
    body: JSON.stringify({ profileId }),
  })
  return response.json()
}

export async function deleteSession(sessionId: string): Promise<void> {
  await fetch(`/api/acp/sessions?sessionId=${encodeURIComponent(sessionId)}`, {
    method: 'DELETE',
  })
}

export async function sendPrompt(sessionId: string, text: string): Promise<void> {
  await fetch('/api/acp/prompt', {
    method: 'POST',
    headers: JSON_HEADERS,
    body: JSON.stringify({ sessionId, text }),
  })
}

export async function cancelTurn(sessionId: string): Promise<void> {
  await fetch('/api/acp/cancel', {
    method: 'POST',
    headers: JSON_HEADERS,
    body: JSON.stringify({ sessionId }),
  })
}

export async function respondPermission(requestId: string, optionId?: string): Promise<void> {
  await fetch('/api/acp/respond', {
    method: 'POST',
    headers: JSON_HEADERS,
    body: JSON.stringify({ type: 'permission', requestId, optionId }),
  })
}

export async function respondAsk(requestId: string, answer?: string): Promise<void> {
  await fetch('/api/acp/respond', {
    method: 'POST',
    headers: JSON_HEADERS,
    body: JSON.stringify({ type: 'ask', requestId, answer }),
  })
}

export async function setMode(sessionId: string, modeId: string): Promise<void> {
  await fetch('/api/acp/mode', {
    method: 'POST',
    headers: JSON_HEADERS,
    body: JSON.stringify({ sessionId, modeId }),
  })
}

export async function fetchSelection(): Promise<AgentSelection> {
  const response = await fetch('/api/acp/config')
  return response.json()
}

export async function saveSelection(selection: AgentSelection): Promise<void> {
  await fetch('/api/acp/config', {
    method: 'POST',
    headers: JSON_HEADERS,
    body: JSON.stringify(selection),
  })
}

export async function fetchMcpServers(): Promise<McpServerConfig[]> {
  const response = await fetch('/api/acp/mcp')
  return response.json()
}

export async function saveMcpServers(servers: McpServerConfig[]): Promise<void> {
  await fetch('/api/acp/mcp', {
    method: 'POST',
    headers: JSON_HEADERS,
    body: JSON.stringify(servers),
  })
}

export async function checkMcpServer(config: McpServerConfig): Promise<McpCheckResult> {
  const response = await fetch('/api/acp/mcp-check', {
    method: 'POST',
    headers: JSON_HEADERS,
    body: JSON.stringify(config),
  })
  return response.json()
}

export async function fetchProfiles(): Promise<ProfilesFile> {
  const response = await fetch('/api/acp/profiles')
  return response.json()
}

export async function saveProfile(profile: AgentProfile): Promise<void> {
  await fetch('/api/acp/profiles', {
    method: 'POST',
    headers: JSON_HEADERS,
    body: JSON.stringify(profile),
  })
}

export async function setActiveProfile(profileId: string): Promise<void> {
  await fetch('/api/acp/profiles', {
    method: 'PATCH',
    headers: JSON_HEADERS,
    body: JSON.stringify({ activeProfileId: profileId }),
  })
}

export async function deleteProfile(profileId: string): Promise<void> {
  await fetch(`/api/acp/profiles?profileId=${encodeURIComponent(profileId)}`, {
    method: 'DELETE',
  })
}

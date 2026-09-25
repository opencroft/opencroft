import { createServerFn } from '@tanstack/react-start'
import { writeSelection } from 'agent-client/config'
import { checkMcpServer, type McpCheckResult } from 'agent-client/mcp-check'
import type { McpServerConfig } from 'agent-client/mcp-types'
import { listOpenAiModels as listModels } from 'agent-client/models'
import {
  type DefaultAccess,
  type PermissionValue,
  type ResolvedPermissions,
  resolveSessionPermissions,
} from 'agent-client/permissions'
import type { AgentProfile, ProfilesFile } from 'agent-client/profiles'
import { rebuildTurn, type TurnEdit } from 'agent-client/queue-tags'
import type { AgentSelection, ElicitationContentValue, QueueMode, SessionMeta } from 'agent-client/types'

import { getRuntime, type RoleRecord, resolveReaderName, type SkillRecord } from './runtime'

// ---- Agent selection (provider / adapter / model / key / cwd) ----

const _getAgentConfig = createServerFn({ method: 'GET' }).handler(async (): Promise<AgentSelection | null> => {
  // Read the saved selection directly so an unconfigured host returns null
  // (readSelection() would substitute a hard-coded default instead).
  const { readFile } = await import('node:fs/promises')
  const { join } = await import('node:path')
  try {
    const raw = await readFile(join(process.cwd(), 'agent-config.json'), 'utf8')
    return JSON.parse(raw) as AgentSelection
  } catch {
    return null
  }
})
export const getAgentConfig = () => _getAgentConfig()

const _saveAgentConfig = createServerFn({ method: 'POST' })
  .inputValidator((selection: AgentSelection) => selection)
  .handler(async ({ data }) => {
    // The agent always runs in the server's working directory.
    await writeSelection({ ...data, cwd: process.cwd() })
    return { ok: true }
  })
export const saveAgentConfig = (selection: AgentSelection) => _saveAgentConfig({ data: selection })

// ---- Agent profiles (multiple saved selections + system prompts) ----

const _listAgentProfiles = createServerFn({ method: 'GET' }).handler(
  async (): Promise<ProfilesFile> => getRuntime().profiles.read(),
)
export const listAgentProfiles = () => _listAgentProfiles()

const _saveAgentProfile = createServerFn({ method: 'POST' })
  .inputValidator((data: { profile: AgentProfile; setActive?: boolean }) => data)
  .handler(async ({ data }): Promise<ProfilesFile> => {
    const store = getRuntime().profiles
    const file = await store.read()
    // The agent always runs in the server's working directory.
    const profile: AgentProfile = {
      ...data.profile,
      selection: { ...data.profile.selection, cwd: process.cwd() },
    }
    const index = file.profiles.findIndex((entry) => entry.id === profile.id)
    if (index >= 0) {
      file.profiles[index] = profile
    } else {
      file.profiles.push(profile)
    }
    if (data.setActive || !file.activeProfileId) {
      file.activeProfileId = profile.id
    }
    await store.write(file)
    return file
  })
export const saveAgentProfile = (profile: AgentProfile, setActive?: boolean) =>
  _saveAgentProfile({ data: { profile, setActive } })

const _deleteAgentProfile = createServerFn({ method: 'POST' })
  .inputValidator((id: string) => id)
  .handler(async ({ data: id }): Promise<ProfilesFile> => {
    const store = getRuntime().profiles
    const file = await store.read()
    file.profiles = file.profiles.filter((entry) => entry.id !== id)
    if (file.activeProfileId === id) {
      file.activeProfileId = file.profiles[0]?.id ?? ''
    }
    await store.write(file)
    return file
  })
export const deleteAgentProfile = (id: string) => _deleteAgentProfile({ data: id })

const _setActiveProfile = createServerFn({ method: 'POST' })
  .inputValidator((id: string) => id)
  .handler(async ({ data: id }) => {
    const store = getRuntime().profiles
    const file = await store.read()
    file.activeProfileId = id
    await store.write(file)
    return { ok: true }
  })
export const setActiveProfile = (id: string) => _setActiveProfile({ data: id })

// ---- Model discovery (OpenAI-compatible /models) ----

const _listOpenAiModels = createServerFn({ method: 'POST' })
  .inputValidator((data: { baseUrl: string; apiKey?: string }) => data)
  .handler(async ({ data }): Promise<string[]> => {
    // The fetch itself lives in the client package: the harness needs the same
    // response to learn a model's context window, and one shape of it is the
    // point. This route only narrows it to the ids the picker renders.
    const models = await listModels(data.baseUrl, data.apiKey)
    return models.map((model) => model.id)
  })
export const listOpenAiModels = (baseUrl: string, apiKey?: string) => _listOpenAiModels({ data: { baseUrl, apiKey } })

// ---- Sessions (single-session model: starting one drops the rest) ----

const _listAgentSessions = createServerFn({ method: 'GET' }).handler(
  async (): Promise<SessionMeta[]> => getRuntime().agent.listSessions(),
)
export const listAgentSessions = () => _listAgentSessions()

// Resolve the active profile's roles into the session's effective permissions.
// With no roles layer configured, returns undefined (unrestricted).
async function resolveActivePermissions(): Promise<ResolvedPermissions | undefined> {
  const { profiles, roles } = getRuntime()
  if (!roles) {
    return undefined
  }
  const file = await profiles.read()
  const active = file.profiles.find((entry) => entry.id === file.activeProfileId)
  const roleIds = active?.roleIds ?? []
  const all = await roles.list()
  const assigned = all.filter((role) => roleIds.includes(role.id))
  const defaultAccess = await roles.getDefaultAccess()
  return resolveSessionPermissions(assigned, defaultAccess)
}

const _startAgentSession = createServerFn({ method: 'POST' })
  .inputValidator((selection: AgentSelection) => selection)
  .handler(async ({ data }): Promise<SessionMeta> => {
    const { agent } = getRuntime()
    // The agent always runs in the server's working directory.
    const selection = { ...data, cwd: process.cwd() }
    await writeSelection(selection)
    const permissions = await resolveActivePermissions()
    for (const session of agent.listSessions()) {
      agent.deleteSession(session.id)
    }
    // Default this page to bypass-permissions (applied when the harness offers it).
    return agent.createSession(selection, 'bypass', permissions)
  })
export const startAgentSession = (selection: AgentSelection) => _startAgentSession({ data: selection })

const _deleteAgentSession = createServerFn({ method: 'POST' })
  .inputValidator((sessionId: string) => sessionId)
  .handler(async ({ data: sessionId }) => {
    getRuntime().agent.deleteSession(sessionId)
    return { ok: true }
  })
export const deleteAgentSession = (sessionId: string) => _deleteAgentSession({ data: sessionId })

const _forkAgentSession = createServerFn({ method: 'POST' })
  .inputValidator((data: { sessionId: string; dropFromTurn?: number }) => data)
  .handler(
    async ({ data }): Promise<SessionMeta | null> => getRuntime().agent.forkSession(data.sessionId, data.dropFromTurn),
  )
export const forkAgentSession = (sessionId: string, dropFromTurn?: number) =>
  _forkAgentSession({ data: { sessionId, dropFromTurn } })

// Commit an edited turn: rewind to it and re-send it with the caller's words in
// place of the messages at these positions.
//
// The words are the only thing this wire carries, and that absence is the same
// mechanism `_sendAgentPrompt` relies on below. Authorship, send times and the
// interrupt note are read back here from the delivered turn — a browser able to
// supply the turn's text could state a tag naming anybody, and the tags are what
// every reader and every replay trust for attribution.
//
// The turn is named by its position in the event log, never by a count of user
// turns: a client showing a bounded tail of a conversation counts different
// turns than a server holding all of it.
//
// Delivered as a `system` prompt because the rebuilt text is already a finished
// delivery body: a message send would tag it again, wrapping the editor's name
// around the old tags escaped into its body.
//
// CONSTRAINT for a host that configures `transformDeliveredPrompt`: this
// re-delivers text that was ALREADY transformed (`userTurnAt` returns what the
// agent received), so a transform runs over it twice. A transform that prepends
// something — a timestamp, an envelope — needs its own inverse applied before
// the rebuild, which this generic action cannot do for it. Hosts that transform
// deliveries should use their own edit path (see this repo's app, which strips
// its delivery stamp first) rather than this one.
//
// WORDS ONLY, and said so rather than assumed: this runtime has no store to
// resolve a picture id against, so an edit that names a message's pictures is
// refused -- dropping the list would re-send the turn without the change the
// reader made. The pictures the turn was delivered with go again, positioned
// on the messages that survive.
const _editAgentTurn = createServerFn({ method: 'POST' })
  .inputValidator((data: { sessionId: string; eventIndex: number; edits: TurnEdit<string>[] }) => data)
  .handler(async ({ data }): Promise<SessionMeta | null> => {
    if (data.edits.some((edit) => edit.attachments)) {
      throw new Error('This runtime cannot change the pictures of an edited message')
    }
    const agent = getRuntime().agent
    const turn = agent.userTurnAt(data.sessionId, data.eventIndex)
    if (!turn) {
      return null
    }
    const words = data.edits.map(({ index, text }) => ({ index, text }))
    const { text, attachments } = rebuildTurn(turn.text, turn.attachments, words)
    const meta = await agent.forkSession(data.sessionId, turn.turnIndex)
    if (!meta) {
      return null
    }
    await agent.prompt(meta.id, text, {
      queue: 'wait',
      origin: { kind: 'system' },
      ...(attachments.length > 0 ? { attachments } : {}),
    })
    return meta
  })
export const editAgentTurn = (sessionId: string, eventIndex: number, edits: TurnEdit<string>[]) =>
  _editAgentTurn({ data: { sessionId, eventIndex, edits } })

// ---- Turn control ----

// `queue` is required here for the same reason it is required everywhere else:
// sending into a session that may be busy is a choice, and a default would make
// it on the caller's behalf without telling them. See QueueMode.
//
// The sender is NOT on this wire, and that absence is the whole mechanism.
// Every message now carries its author into the agent's own reading of it, so a
// browser able to pass `sender` could be attributed as anybody — the name would
// be quoted verbatim in the transcript and in every agent's view of who said
// what. It is resolved from the host's request context instead, which the
// client cannot reach. See ReaderIdentity.
const _sendAgentPrompt = createServerFn({ method: 'POST' })
  .inputValidator((data: { sessionId: string; text: string; queue: QueueMode }) => data)
  .handler(async ({ data }) => {
    const { interrupted } = await getRuntime().agent.prompt(data.sessionId, data.text, {
      queue: data.queue,
      origin: { kind: 'message', sender: await resolveReaderName() },
    })
    return { ok: true, interrupted }
  })
export const sendAgentPrompt = (sessionId: string, text: string, queue: QueueMode) =>
  _sendAgentPrompt({ data: { sessionId, text, queue } })

const _cancelAgentTurn = createServerFn({ method: 'POST' })
  .inputValidator((sessionId: string) => sessionId)
  .handler(async ({ data: sessionId }) => {
    await getRuntime().agent.cancel(sessionId)
    return { ok: true }
  })
export const cancelAgentTurn = (sessionId: string) => _cancelAgentTurn({ data: sessionId })

const _respondAgent = createServerFn({ method: 'POST' })
  .inputValidator(
    (data: {
      type: 'permission' | 'ask'
      requestId: string
      optionId?: string
      answer?: string | Record<string, ElicitationContentValue>
    }) => data,
  )
  .handler(async ({ data }) => {
    const { agent } = getRuntime()
    if (data.type === 'permission') {
      agent.resolvePermission(data.requestId, data.optionId)
    } else {
      agent.resolveElicitation(data.requestId, data.answer)
    }
    return { ok: true }
  })
export const respondPermission = (requestId: string, optionId?: string) =>
  _respondAgent({ data: { type: 'permission', requestId, optionId } })
export const respondAsk = (requestId: string, answer?: string | Record<string, ElicitationContentValue>) =>
  _respondAgent({ data: { type: 'ask', requestId, answer } })

const _setAgentMode = createServerFn({ method: 'POST' })
  .inputValidator((data: { sessionId: string; modeId: string }) => data)
  .handler(async ({ data }) => {
    await getRuntime().agent.setMode(data.sessionId, data.modeId)
    return { ok: true }
  })
export const setAgentMode = (sessionId: string, modeId: string) => _setAgentMode({ data: { sessionId, modeId } })

const _setAgentConfigOption = createServerFn({ method: 'POST' })
  .inputValidator((data: { sessionId: string; configId: string; value: string | boolean }) => data)
  .handler(async ({ data }) => {
    await getRuntime().agent.setConfigOption(data.sessionId, data.configId, data.value)
    return { ok: true }
  })
export const setAgentConfigOption = (sessionId: string, configId: string, value: string | boolean) =>
  _setAgentConfigOption({ data: { sessionId, configId, value } })

const _removeQueuedPrompt = createServerFn({ method: 'POST' })
  .inputValidator((data: { sessionId: string; id: string }) => data)
  .handler(async ({ data }) => {
    getRuntime().agent.removeQueued(data.sessionId, data.id)
    return { ok: true }
  })
export const removeQueuedPrompt = (sessionId: string, id: string) => _removeQueuedPrompt({ data: { sessionId, id } })

// ---- MCP server (single optional server, edited via dialog) ----

const _getMcpServers = createServerFn({ method: 'GET' }).handler(
  async (): Promise<McpServerConfig[]> => getRuntime().mcp.read(),
)
export const getMcpServers = () => _getMcpServers()

const _saveMcpServers = createServerFn({ method: 'POST' })
  .inputValidator((servers: McpServerConfig[]) => servers)
  .handler(async ({ data }) => {
    await getRuntime().mcp.write(data)
    // Re-resume live sessions so they pick up the new server set.
    await getRuntime().agent.refreshMcpServers()
    return { ok: true }
  })
export const saveMcpServers = (servers: McpServerConfig[]) => _saveMcpServers({ data: servers })

const _checkMcpServer = createServerFn({ method: 'POST' })
  .inputValidator((config: McpServerConfig) => config)
  .handler(async ({ data }): Promise<McpCheckResult> => checkMcpServer(data))
export const checkMcpServerConfig = (config: McpServerConfig) => _checkMcpServer({ data: config })

// ---- Skills (the agent's editable, load-on-demand instruction catalog) ----

export type { SkillRecord }

const _getSkills = createServerFn({ method: 'GET' }).handler(
  async (): Promise<SkillRecord[]> => getRuntime().skills.list(),
)
export const getSkills = () => _getSkills()

const _createSkill = createServerFn({ method: 'POST' })
  .inputValidator((data: { name: string; description?: string; content?: string }) => data)
  .handler(async ({ data }): Promise<SkillRecord> => getRuntime().skills.create(data))
export const createSkill = (input: { name: string; description?: string; content?: string }) =>
  _createSkill({ data: input })

const _updateSkill = createServerFn({ method: 'POST' })
  .inputValidator((data: { name: string; updates: { name?: string; description?: string; content?: string } }) => data)
  .handler(async ({ data }): Promise<SkillRecord | null> => {
    try {
      // A renamed skill can collide with an existing name (unique constraint).
      return await getRuntime().skills.update(data.name, data.updates)
    } catch {
      return null
    }
  })
export const updateSkill = (name: string, updates: { name?: string; description?: string; content?: string }) =>
  _updateSkill({ data: { name, updates } })

const _deleteSkill = createServerFn({ method: 'POST' })
  .inputValidator((name: string) => name)
  .handler(async ({ data: name }): Promise<boolean> => {
    try {
      await getRuntime().skills.remove(name)
      return true
    } catch {
      return false
    }
  })
export const deleteSkill = (name: string) => _deleteSkill({ data: name })

// ---- Agent tools (the local tool catalog, for the roles editor) ----

const _getAgentTools = createServerFn({ method: 'GET' }).handler(
  async (): Promise<{ name: string; description: string }[]> => getRuntime().agent.listTools(),
)
export const getAgentTools = () => _getAgentTools()

// ---- Agent roles (per-tool / per-skill permissions) ----

export type { RoleRecord }

function rolesLayer() {
  const { roles } = getRuntime()
  if (!roles) {
    throw new Error('agent-chat: no roles data layer configured.')
  }
  return roles
}

const _getAgentRoles = createServerFn({ method: 'GET' }).handler(async (): Promise<RoleRecord[]> => rolesLayer().list())
export const getAgentRoles = () => _getAgentRoles()

const _createAgentRole = createServerFn({ method: 'POST' })
  .inputValidator((data: { name: string; description?: string; permissions?: Record<string, PermissionValue> }) => data)
  .handler(async ({ data }): Promise<RoleRecord> => rolesLayer().create(data))
export const createAgentRole = (input: {
  name: string
  description?: string
  permissions?: Record<string, PermissionValue>
}) => _createAgentRole({ data: input })

const _updateAgentRole = createServerFn({ method: 'POST' })
  .inputValidator(
    (data: {
      id: string
      updates: {
        name?: string
        description?: string
        permissions?: Record<string, PermissionValue>
      }
    }) => data,
  )
  .handler(async ({ data }): Promise<RoleRecord | null> => {
    try {
      // A renamed role can collide with an existing name (unique constraint).
      return await rolesLayer().update(data.id, data.updates)
    } catch {
      return null
    }
  })
export const updateAgentRole = (
  id: string,
  updates: {
    name?: string
    description?: string
    permissions?: Record<string, PermissionValue>
  },
) => _updateAgentRole({ data: { id, updates } })

const _deleteAgentRole = createServerFn({ method: 'POST' })
  .inputValidator((id: string) => id)
  .handler(async ({ data: id }): Promise<boolean> => {
    try {
      await rolesLayer().remove(id)
      return true
    } catch {
      return false
    }
  })
export const deleteAgentRole = (id: string) => _deleteAgentRole({ data: id })

const _getDefaultAccess = createServerFn({ method: 'GET' }).handler(
  async (): Promise<DefaultAccess> => rolesLayer().getDefaultAccess(),
)
export const getDefaultAccess = () => _getDefaultAccess()

const _setDefaultAccess = createServerFn({ method: 'POST' })
  .inputValidator((access: DefaultAccess) => access)
  .handler(async ({ data: access }) => {
    await rolesLayer().setDefaultAccess(access)
    return { ok: true }
  })
export const setDefaultAccess = (access: DefaultAccess) => _setDefaultAccess({ data: access })

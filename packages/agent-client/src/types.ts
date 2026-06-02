export interface SpawnConfig {
  command: string
  args: string[]
  cwd: string
  env: Record<string, string>
}

export interface AgentSelection {
  providerId: string
  adapterId: string
  model: string
  apiKey: string
  cwd: string
}

export interface SessionMeta {
  id: string
  title: string
  createdAt: number
  profileId?: string
}

export interface PlanItem {
  content: string
  status: string
  priority: string
}

export interface PermissionOpt {
  id: string
  label: string
  kind: string
}

export type ChatEvent =
  | { kind: 'user'; text: string }
  | { kind: 'agent_message'; text: string }
  | { kind: 'agent_thought'; text: string }
  | {
      kind: 'tool_call'
      toolCallId: string
      title: string
      status: string
      toolKind?: string
      input?: unknown
    }
  | {
      kind: 'tool_update'
      toolCallId: string
      title?: string
      status?: string
      input?: unknown
      output?: unknown
    }
  | { kind: 'plan'; entries: PlanItem[] }
  | {
      kind: 'permission_request'
      requestId: string
      title: string
      options: PermissionOpt[]
    }
  | { kind: 'permission_resolved'; requestId: string; optionId?: string }
  | { kind: 'ask_user'; requestId: string; message: string }
  | { kind: 'ask_user_resolved'; requestId: string }
  | { kind: 'modes'; available: SessionMode[]; current: string }
  | { kind: 'mode_changed'; current: string }
  | { kind: 'turn_end'; stopReason: string }
  | { kind: 'error'; message: string }

export interface SessionMode {
  id: string
  name: string
  description?: string
}

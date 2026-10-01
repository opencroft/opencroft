'use client'

import { normalizeToolId, type ToolViewProps } from 'agent-chat/tool-views'
import type { ComponentType } from 'react'

import { DefaultToolView } from './approval-fields'
import {
  AgentEditView,
  AgentMultiEditView,
  AgentWriteView,
  RemoteEditView,
  RemoteReadView,
  RemoteWriteView,
} from './file-views'
import { AppCallView, appCallNodeId, argNodeId } from './graph-views'
import { AskUserQuestionView, CallView, RemoteExecView, RemoteScriptView } from './run-views'
import { SkillEditView, SkillWriteView } from './skill-views'

// A rich, tool-specific view of a tool call — shared by the approval prompt
// (before the call runs) and the chat transcript (after it ran). `mode` tells a
// view which side of the call it's rendering: 'approval' has live pre-call
// state to diff against args; 'history' only has post-call live state, so a
// view that wants a diff must reconstruct the "before" side from args instead.
//
// Everything a view needs from the product it runs in comes through
// useToolViewHost(). No view reads a canvas, an overlay or a store directly.
export interface ToolViewSpec {
  body: ComponentType<ToolViewProps>
  getNodeId?: (args: Record<string, unknown>) => string | undefined
}

const DEFAULT_SPEC: ToolViewSpec = { body: DefaultToolView }

const targetNodeId = (args: Record<string, unknown>) => (args.target as string | undefined)?.split('/')[0]

const APP_CALL_SPEC: ToolViewSpec = { body: AppCallView, getNodeId: appCallNodeId }

// Every view, keyed by the tool's programmatic name. The agent's own tools are
// keyed the same way, which is what the transcript matches on — their
// displayed titles embed an argument, so no fixed id could ever equal one.
// `getNodeId` names the node a call acts on, for a host that offers to show it.
export const TOOL_VIEWS: Readonly<Record<string, ToolViewSpec>> = {
  Write: { body: AgentWriteView },
  Edit: { body: AgentEditView },
  MultiEdit: { body: AgentMultiEditView },
  AskUserQuestion: { body: AskUserQuestionView },
  remote_read: { body: RemoteReadView, getNodeId: targetNodeId },
  remote_exec: { body: RemoteExecView, getNodeId: targetNodeId },
  remote_script: { body: RemoteScriptView, getNodeId: targetNodeId },
  remote_write: { body: RemoteWriteView, getNodeId: targetNodeId },
  remote_edit: { body: RemoteEditView, getNodeId: targetNodeId },
  skill_write: { body: SkillWriteView },
  skill_edit: { body: SkillEditView },
  call: { body: CallView, getNodeId: argNodeId },
  'graph.updateNodes': APP_CALL_SPEC,
  'graph.writeNodeProperty': APP_CALL_SPEC,
  'graph.editNodeProperty': APP_CALL_SPEC,
  app_call: APP_CALL_SPEC,
}

// Only a specifically registered view, or undefined — for callers (the chat
// transcript) that already have a reasonable default of their own to fall back
// to instead of the raw-args dump. The id is normalized first, so a tool
// reported with an MCP server prefix still finds its view. Own keys only: a
// tool that happens to be called `toString` or `constructor` must find nothing
// rather than something inherited from Object.
export function lookupToolView(id: string): ToolViewSpec | undefined {
  const key = normalizeToolId(id)
  return Object.hasOwn(TOOL_VIEWS, key) ? TOOL_VIEWS[key] : undefined
}

// Always returns a spec, falling back to the raw-args dump — for callers (the
// approval prompt) that must render something regardless of whether a rich
// view is registered.
export function resolveToolView(id?: string): ToolViewSpec {
  if (!id) {
    return DEFAULT_SPEC
  }
  return lookupToolView(id) ?? DEFAULT_SPEC
}

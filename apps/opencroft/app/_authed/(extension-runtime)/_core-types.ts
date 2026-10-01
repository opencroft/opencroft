// Core's node and handle types as graphs and manifests the host has read carry
// them: qualified with core's extension id. For host code outside core that
// recognises one of them. Core's own extension code compares the bare names it
// declares, and the agent node types live with the rest of that node's shape
// (agent-node-shape.ts).
//
// Safe for both server and client — no runtime imports.

import { TERMINAL_ROUTER_TYPE } from '@/app/_authed/(extension-runtime)/_builtin/core/src/nodes/terminal-router-shared'
import { CORE_EXTENSION_ID, qualifyType } from '@/app/_authed/(extension-runtime)/_extension-id'

/** One of core's bare types in its stored form. */
export function coreType(bare: string): string {
  return qualifyType(CORE_EXTENSION_ID, bare)
}

export const TERMINAL_ROUTER_NODE_TYPE = coreType(TERMINAL_ROUTER_TYPE)
export const LOG_NODE_TYPE = coreType('log')
export const API_ROUTE_NODE_TYPE = coreType('api-route')
export const EVENT_NODE_TYPE = coreType('event')

/** What a terminal source hands on: a terminal to run commands in. */
export const TERMINAL_CONTEXT_HANDLE_TYPE = coreType('terminal-context')

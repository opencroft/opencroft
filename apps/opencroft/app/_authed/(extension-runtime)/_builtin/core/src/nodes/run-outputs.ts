// The run-time outputs of the three producers of an execution (API Route,
// Event, Agent Tool): what each was given in a run, as values. Each output
// has a value only while its node's run dispatches, read from the event the
// node dispatched (`exposeOutput`'s `run`), and nothing otherwise, so the
// canvas never has one.
//
// Pure: no runtime imports.

import { isObjectValue } from '@opencroft/core/values'

import type { ExtensionHandle } from '@/app/_authed/(extension-runtime)/_types'

// Handle types as core declares its own: bare.
function runOutput(id: string, handleType: string, label: string): ExtensionHandle {
  return { id, handleType, role: 'source', label, runtime: true }
}

/** The run-time outputs of each producer, by its bare type, in the order its card draws them. */
export const RUN_OUTPUTS: Readonly<Record<string, readonly ExtensionHandle[]>> = {
  'api-route': [
    runOutput('body', 'object', 'Body'),
    runOutput('text', 'string', 'Text'),
    runOutput('query', 'object', 'Query'),
    runOutput('params', 'object', 'Params'),
    runOutput('headers', 'object', 'Headers'),
    runOutput('method', 'string', 'Method'),
  ],
  event: [runOutput('payload', 'object', 'Payload'), runOutput('firedAt', 'number', 'Fired at')],
  'agent-tool': [runOutput('args', 'object', 'Arguments')],
}

function field(run: unknown, key: string): unknown {
  return isObjectValue(run) && Object.hasOwn(run, key) ? run[key] : undefined
}

function objectOf(value: unknown): unknown {
  return isObjectValue(value) ? value : undefined
}

function stringOf(value: unknown): string | undefined {
  return typeof value === 'string' ? value : undefined
}

/**
 * What the run-time output `handleId` of a producer of bare type `type`
 * carries in the run whose event is `run`, or undefined: outside a run, for
 * a handle that is not one of its run-time outputs, and for a value that is
 * not of the output's type (a JSON body that is a list gives no `body`).
 */
export function runOutputValue(type: string, handleId: string, run: unknown): unknown {
  if (run === undefined) {
    return undefined
  }
  switch (`${type}/${handleId}`) {
    case 'api-route/body':
    case 'api-route/query':
    case 'api-route/params':
    case 'api-route/headers':
      return objectOf(field(run, handleId))
    case 'api-route/text':
    case 'api-route/method':
      return stringOf(field(run, handleId))
    case 'event/payload':
      return objectOf(field(run, 'payload'))
    case 'event/firedAt': {
      const firedAt = field(run, 'firedAt')
      return typeof firedAt === 'number' && Number.isFinite(firedAt) ? firedAt : undefined
    }
    case 'agent-tool/args':
      return objectOf(field(run, 'params'))
    default:
      return undefined
  }
}

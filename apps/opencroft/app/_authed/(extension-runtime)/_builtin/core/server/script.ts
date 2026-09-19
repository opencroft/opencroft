import host from '@opencroft/server'
import type { TerminalContext } from '@opencroft/server'

export interface ScriptRunParams {
  script: string
  language: 'bash' | 'python' | 'node'
  context: TerminalContext
  env?: Record<string, string>
}

export interface ScriptResult {
  stdout: string
  stderr: string
  exitCode: number
}

const LANG_CMD: Record<string, string> = {
  bash: 'bash',
  python: 'python',
  node: 'node',
}

const LANG_FLAG: Record<string, string> = {
  bash: '-c',
  python: '-c',
  node: '-e',
}

export async function runScript(params: ScriptRunParams): Promise<ScriptResult> {
  const { script, language, context, env } = params
  try {
    const stdout = await host.terminal.run(context, [LANG_CMD[language], LANG_FLAG[language], script], env)
    return { stdout, stderr: '', exitCode: 0 }
  } catch (err) {
    const msg = (err as Error).message || String(err)
    return { stdout: '', stderr: msg, exitCode: 1 }
  }
}

// ═══════════════════════════════════════════════════════════════════
// Handler execution — ExecutionContext<HTTPRequest> -> HTTPResponse
// ═══════════════════════════════════════════════════════════════════

export interface HandlerRunParams {
  script: string
  language: 'bash' | 'python' | 'node'
  context: TerminalContext
  event: unknown
  env?: Record<string, string>
}

export interface HandlerResult {
  status?: number
  headers?: Record<string, string>
  body?: unknown
  error?: string
  logs?: string
}

const RESULT_MARKER = '__OPENCROFT_HANDLER_RESULT__'

function pythonHandlerBootstrap(eventB64: string): string {
  return `
import json, sys, base64
_event = json.loads(base64.b64decode('${eventB64}').decode('utf-8'))
_result = handler(_event)
if not isinstance(_result, dict):
    _result = {"body": _result}
print('${RESULT_MARKER}' + json.dumps(_result))
sys.exit(0)
`
}

function nodeHandlerBootstrap(eventB64: string): string {
  return `
const _event = JSON.parse(Buffer.from('${eventB64}', 'base64').toString('utf-8'));
Promise.resolve(typeof handler === 'function' ? handler(_event) : undefined)
  .then(function(_result) {
    if (_result === null || _result === undefined) _result = {};
    if (typeof _result !== 'object' || Array.isArray(_result)) _result = { body: _result };
    console.log('${RESULT_MARKER}' + JSON.stringify(_result));
    process.exit(0);
  })
  .catch(function(_e) {
    console.error(_e.message || String(_e));
    process.exit(1);
  });
`
}

interface SplitOutput {
  result: string
  logs: string
}

function splitStdout(stdout: string): SplitOutput {
  const idx = stdout.lastIndexOf(RESULT_MARKER)
  if (idx < 0) {
    throw new Error('Handler did not produce a result')
  }
  const before = stdout.slice(0, idx)
  const tail = stdout.slice(idx + RESULT_MARKER.length)
  const newline = tail.indexOf('\n')
  const result = newline < 0 ? tail : tail.slice(0, newline)
  const after = newline < 0 ? '' : tail.slice(newline + 1)
  return { result, logs: before + after }
}

// Python and Node.js handlers are a `handler(event)` function the bootstrap
// appended here calls, reporting its return value on a RESULT_MARKER line. A
// bash handler is the script itself: it reads the event as JSON from
// OPENCROFT_EVENT, and its stdout is the response body unless it prints a
// RESULT_MARKER line of its own, which is then read the same way.
function runHandlerScript(params: HandlerRunParams): Promise<string> {
  const { script, language, context, event, env } = params
  if (language === 'bash') {
    return host.terminal.run(context, ['bash', '-c', script], { ...env, OPENCROFT_EVENT: JSON.stringify(event) })
  }
  const eventB64 = Buffer.from(JSON.stringify(event), 'utf-8').toString('base64')
  if (language === 'python') {
    return host.terminal.run(context, ['python', '-c', script + pythonHandlerBootstrap(eventB64)], env)
  }
  if (language === 'node') {
    return host.terminal.run(context, ['node', '-e', script + nodeHandlerBootstrap(eventB64)], env)
  }
  throw new Error(`Unsupported language: ${language}`)
}

export async function runHandler(params: HandlerRunParams): Promise<HandlerResult> {
  const { language, env } = params

  try {
    const stdout = await runHandlerScript(params)
    if (language === 'bash' && !stdout.includes(RESULT_MARKER)) {
      return { status: 200, body: stdout }
    }

    const { result, logs } = splitStdout(stdout)
    const parsed = JSON.parse(result)
    return {
      status: parsed.status ?? 200,
      headers: parsed.headers,
      body: parsed.body,
      logs,
    }
  } catch (err) {
    let msg = (err as Error).message || String(err)
    // Redact secret values that may have leaked into the command line via env prefix
    if (env) {
      for (const v of Object.values(env)) {
        if (v && v.length >= 4) {
          msg = msg.split(v).join('<redacted>')
        }
      }
    }
    return { status: 500, error: msg }
  }
}

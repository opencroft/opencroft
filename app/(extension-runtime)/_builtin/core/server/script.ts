import { type TerminalContext, terminalRun } from './terminal';

export interface ScriptRunParams {
  script: string;
  language: 'bash' | 'python' | 'node';
  context: TerminalContext;
  env?: Record<string, string>;
}

export interface ScriptResult {
  stdout: string;
  stderr: string;
  exitCode: number;
}

const LANG_CMD: Record<string, string> = {
  bash: 'bash',
  python: 'python',
  node: 'node',
};

const LANG_FLAG: Record<string, string> = {
  bash: '-c',
  python: '-c',
  node: '-e',
};

export async function runScript(params: ScriptRunParams): Promise<ScriptResult> {
  const { script, language, context, env } = params;
  try {
    const stdout = await terminalRun(context, [LANG_CMD[language], LANG_FLAG[language], script], env);
    return { stdout, stderr: '', exitCode: 0 };
  } catch (err) {
    const msg = (err as Error).message || String(err);
    return { stdout: '', stderr: msg, exitCode: 1 };
  }
}

// ═══════════════════════════════════════════════════════════════════
// Handler execution — ExecutionContext<HTTPRequest> -> HTTPResponse
// ═══════════════════════════════════════════════════════════════════

export interface HandlerRunParams {
  script: string;
  language: 'python' | 'node';
  context: TerminalContext;
  event: unknown;
  env?: Record<string, string>;
}

export interface HandlerResult {
  status?: number;
  headers?: Record<string, string>;
  body?: unknown;
  error?: string;
  logs?: string;
}

const RESULT_MARKER = '__OPENCROFT_HANDLER_RESULT__';

function pythonHandlerBootstrap(eventB64: string): string {
  return `
import json, sys, base64
_event = json.loads(base64.b64decode('${eventB64}').decode('utf-8'))
_result = handler(_event)
if not isinstance(_result, dict):
    _result = {"body": _result}
print('${RESULT_MARKER}' + json.dumps(_result))
sys.exit(0)
`;
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
`;
}

interface SplitOutput {
  result: string;
  logs: string;
}

function splitStdout(stdout: string): SplitOutput {
  const idx = stdout.lastIndexOf(RESULT_MARKER);
  if (idx < 0) {
    throw new Error('Handler did not produce a result');
  }
  const before = stdout.slice(0, idx);
  const tail = stdout.slice(idx + RESULT_MARKER.length);
  const newline = tail.indexOf('\n');
  const result = newline < 0 ? tail : tail.slice(0, newline);
  const after = newline < 0 ? '' : tail.slice(newline + 1);
  return { result, logs: before + after };
}

export async function runHandler(params: HandlerRunParams): Promise<HandlerResult> {
  const { script, language, context, event, env } = params;
  const eventB64 = Buffer.from(JSON.stringify(event), 'utf-8').toString('base64');

  try {
    let fullScript: string;
    let stdout: string;
    if (language === 'python') {
      fullScript = script + pythonHandlerBootstrap(eventB64);
      stdout = await terminalRun(context, ['python', '-c', fullScript], env);
    } else if (language === 'node') {
      fullScript = script + nodeHandlerBootstrap(eventB64);
      stdout = await terminalRun(context, ['node', '-e', fullScript], env);
    } else {
      return { status: 500, body: { error: `Unsupported language: ${language}` } };
    }

    const { result, logs } = splitStdout(stdout);
    const parsed = JSON.parse(result);
    return {
      status: parsed.status ?? 200,
      headers: parsed.headers,
      body: parsed.body,
      logs,
    };
  } catch (err) {
    let msg = (err as Error).message || String(err);
    // Redact secret values that may have leaked into the command line via env prefix
    if (env) {
      for (const v of Object.values(env)) {
        if (v && v.length >= 4) {
          msg = msg.split(v).join('<redacted>');
        }
      }
    }
    return { status: 500, error: msg };
  }
}

import { spawn } from 'node:child_process';

import host from '@ext/host';

import { sshExec } from './ssh';

function execViaStdin(cmd: string, args: string[], script: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const proc = spawn(cmd, args, { stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true });
    let out = '';
    let err = '';
    proc.stdout.on('data', (d) => { out += d.toString(); });
    proc.stderr.on('data', (d) => { err += d.toString(); });
    proc.on('error', reject);
    proc.on('close', (code) => {
      if (code === 0) {
        resolve(out);
      } else {
        reject(new Error(err || `Exit ${code}`));
      }
    });
    proc.stdin.end(script);
  });
}

export interface TerminalContext {
  type: string;
  distro?: string;
  host?: string;
  port?: number;
  username?: string;
  password?: string;
  keyPath?: string;
  via?: TerminalContext;
  contextName?: string;
  containerId?: string;
  [key: string]: unknown;
}

function shellJoin(args: string[]): string {
  return args.map((a) => {
    if (/^[\w./:@=,-]+$/.test(a)) {
      return a;
    }
    return "'" + a.replace(/'/g, "'\\''") + "'";
  }).join(' ');
}

function dockerExecPrefix(ctx: TerminalContext): string[] {
  const ctxArgs = ctx.contextName ? ['--context', ctx.contextName] : [];
  return ['docker', ...ctxArgs, 'exec', '-i', ctx.containerId ?? ''];
}

export async function terminalRun(ctx: TerminalContext, args: string[]): Promise<string> {
  if (ctx.type === 'docker-exec' && ctx.via) {
    return terminalRun(ctx.via, [...dockerExecPrefix(ctx), 'sh', '-c', shellJoin(args)]);
  }

  if (ctx.type === 'ssh') {
    return sshExec({
      address: ctx.host as string,
      port: (ctx.port as number) || 22,
      username: (ctx.username as string) || 'root',
      password: ctx.password,
      keyPath: ctx.keyPath,
    }, shellJoin(args));
  }

  if (ctx.type === 'wsl' && ctx.distro) {
    return host.execFile('wsl', ['-d', ctx.distro, '--exec', ...args]);
  }

  // host.exec runs through bash -c on all platforms
  return host.exec(shellJoin(args));
}

export async function terminalExec(ctx: TerminalContext, command: string): Promise<string> {
  if (ctx.type === 'docker-exec' && ctx.via) {
    return terminalExec(ctx.via, `${shellJoin(dockerExecPrefix(ctx))} sh -c ${shellJoin([command])}`);
  }

  if (ctx.type === 'ssh') {
    return sshExec({
      address: ctx.host as string,
      port: (ctx.port as number) || 22,
      username: (ctx.username as string) || 'root',
      password: ctx.password,
      keyPath: ctx.keyPath,
    }, command);
  }

  if (ctx.type === 'wsl' && ctx.distro) {
    return execViaStdin('wsl', ['-d', ctx.distro, '--', 'bash'], command);
  }

  return host.exec(command);
}
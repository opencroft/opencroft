// The node runner's transport, made of the remote tools' own pieces: the same
// target resolution (graph nodes, local extensions, App handle addresses), the
// same cwd rule, the same secrets injection, the same exec and the same atomic
// file write. A background command reaches exactly what a synchronous one on
// the same target would have.
//
// LOADED ONLY WITH import(), and the tool registry first. remote-tools.ts's own
// import graph comes back round to tools.ts, which reads remote-tools' exports
// while it loads — so remote-tools can finish loading only when the registry
// started first, and importing it before anything else has loaded the registry
// dies on an uninitialised binding. Loaded in this order, every name below is
// already there.
import '@/app/_authed/(mcp)/_server/tools'

import {
  remoteExec,
  resolveRemoteFilePath,
  resolveSecretsEnv,
  resolveTerminalContext,
  writeFileExactWith,
} from '@/app/_authed/(mcp)/_server/remote-tools'
import type { NodeTransport } from './node-runner'

export const remoteToolsTransport: NodeTransport = {
  resolve: async (target, cwd) => {
    const { ctx } = await resolveTerminalContext({ target })
    const own = ctx.cwd as string | undefined
    return { ctx, cwd: cwd ? resolveRemoteFilePath(cwd, own) : own }
  },
  exec: remoteExec,
  secretsEnv: resolveSecretsEnv,
  writeFile: (ctx, filePath, content) =>
    writeFileExactWith((command) => remoteExec(ctx, command, { cwd: '/' }), filePath, content),
}

/**
 * remote_view_image: a picture on a remote node, handed to the caller as an MCP
 * image block so a vision model sees it rather than its bytes as text. The
 * reading and the picture work are in remote-image.ts; this is the tool.
 */

import {
  buildImageProbeCommand,
  describeView,
  parseImageProbe,
  parseRegion,
  prepareImage,
  readRemoteBytes,
} from '@/app/_authed/(mcp)/_server/remote-image'
import {
  remoteExecDetailed,
  resolveRemoteFilePath,
  resolveTerminalContext,
  shellQuote,
} from '@/app/_authed/(mcp)/_server/remote-tools'
import type { ToolHandler } from '@/app/_authed/(mcp)/_server/tool-caller'
import { fail } from '@/app/_authed/(mcp)/_server/tool-shared'

export const definitions = [
  {
    name: 'remote_view_image',
    description:
      'View an image file on a remote node: it comes back as an image, so you see the picture itself. The target is an output handle carrying a terminal (handle type builtin.core.terminal-context), "<node-id>/<handle-id>" or an App instance\'s "<space>.<app-slug>/<handle-id>", as for remote_read. PNG, JPEG, WebP and GIF, judged by the file\'s content, not its name; anything else is refused. A picture larger than a vision model looks at is scaled down (aspect ratio kept), and the text part says so, with the original size and the size sent. To see a detail of a large picture at full resolution, pass `region`: it is cropped before any scaling. A file too large to read is refused, never cut.',
    inputSchema: {
      type: 'object' as const,
      properties: {
        target: {
          type: 'string',
          description:
            'Output handle carrying a terminal (builtin.core.terminal-context): "<node-id>/<handle-id>", or an App instance\'s "<space>.<app-slug>/<handle-id>" — see app_list for addresses.',
        },
        path: {
          type: 'string',
          description:
            "Absolute image file path on the remote node, or a path relative to the target's working directory when it has one.",
        },
        region: {
          type: 'object',
          description:
            "Optional crop, in the source picture's pixels (as displayed, after any recorded rotation): the rectangle at x, y of width × height. Must lie inside the picture.",
          properties: {
            x: { type: 'number', description: 'Left edge, from 0.' },
            y: { type: 'number', description: 'Top edge, from 0.' },
            width: { type: 'number', description: 'Width, at least 1.' },
            height: { type: 'number', description: 'Height, at least 1.' },
          },
          required: ['x', 'y', 'width', 'height'],
        },
      },
      required: ['target', 'path'],
    },
  },
]

export const handlers: Record<string, ToolHandler> = {
  // AUTO-ALLOWED (see READ_ONLY_TOOLS), on the same conjunction as remote_read:
  // the commands it composes (buildImageProbeCommand, buildChunkReadCommand)
  // use only reading verbs -- wc, head, tail, base64, tr -- and quote the one
  // value interpolated into them. Changing either is a change to that
  // classification.
  remote_view_image: async (args) => {
    const filePath = args.path as string | undefined
    if (!filePath) {
      fail(-32602, 'Missing required param: path')
    }
    const region = parseRegion(args.region)
    const { ctx } = await resolveTerminalContext(args)
    const resolvedPath = resolveRemoteFilePath(filePath, ctx.cwd as string | undefined)
    const exec = (command: string) => remoteExecDetailed(ctx, command)
    const probed = parseImageProbe((await exec(buildImageProbeCommand(resolvedPath, shellQuote))).stdout, resolvedPath)
    const bytes = await readRemoteBytes(exec, resolvedPath, probed.size, shellQuote)
    const image = await prepareImage(bytes, probed.mimeType, resolvedPath, region)
    return {
      content: [
        { type: 'text' as const, text: describeView(resolvedPath, image) },
        { type: 'image' as const, data: image.data.toString('base64'), mimeType: image.mimeType },
      ],
    }
  },
}

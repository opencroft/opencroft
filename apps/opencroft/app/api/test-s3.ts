import { DeleteObjectCommand, ListObjectsCommand, S3Client } from '@aws-sdk/client-s3'
import { createFileRoute } from '@tanstack/react-router'

import type { S3Config } from '@/app/(filemanager)/_lib/types'
import { getConnections } from '@/app/(filemanager)/_server/connection-actions'

export const Route = createFileRoute('/api/test-s3')({
  server: {
    handlers: {
      GET: async () => {
        const config = (await getConnections()).find((c) => c.type === 's3')?.config as S3Config
        if (!config) {
          return Response.json({ error: 'No S3' })
        }

        const client = new S3Client({
          endpoint: config.endpoint || undefined,
          region: config.region || 'us-east-1',
          credentials: { accessKeyId: config.accessKeyId, secretAccessKey: config.secretAccessKey },
          forcePathStyle: true,
        })
        client.middlewareStack.add(
          (next) => async (args) => {
            const request = args.request as { path?: string }
            if (request?.path?.match(/^\/[^/]+\/(\?|$)/)) {
              request.path = request.path.replace(/\/+(\?|$)/, '$1')
            }
            return next(args)
          },
          { step: 'build', name: 'fixTrailingSlash', priority: 'low' },
        )

        // List with Delimiter
        const withDelim = await client.send(
          new ListObjectsCommand({
            Bucket: config.bucket,
            Prefix: 'test-folder/',
            Delimiter: '/',
          }),
        )

        // List without Delimiter
        const withoutDelim = await client.send(
          new ListObjectsCommand({
            Bucket: config.bucket,
            Prefix: 'test-folder/',
          }),
        )

        // Try deleting the .keep directly
        let deleteResult = 'not attempted'
        try {
          await client.send(new DeleteObjectCommand({ Bucket: config.bucket, Key: 'test-folder/.keep' }))
          deleteResult = 'success'
        } catch (e: unknown) {
          deleteResult = (e as Error).message
        }

        return Response.json({
          withDelim: {
            prefixes: withDelim.CommonPrefixes?.map((p) => p.Prefix),
            files: withDelim.Contents?.map((c) => c.Key),
          },
          withoutDelim: {
            files: withoutDelim.Contents?.map((c) => c.Key),
            count: withoutDelim.Contents?.length,
            firstKey: withoutDelim.Contents?.[0]?.Key,
          },
          deleteResult,
        })
      },
    },
  },
})

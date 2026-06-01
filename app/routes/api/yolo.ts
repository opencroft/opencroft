import { createFileRoute } from '@tanstack/react-router';

import { getYoloModeInfo } from '@/app/(mcp)/api/mcp/yolo';

export const Route = createFileRoute('/api/yolo')({
  server: {
    handlers: {
      GET: async () => {
        const info = getYoloModeInfo();
        return Response.json(info);
      },
    },
  },
});

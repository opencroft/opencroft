import { createFileRoute } from '@tanstack/react-router';

import { toastStore } from '@/lib/toast-store';
import { getAllDockerSnapshots } from '@/server/scheduler/docker-ps-poller';

export const Route = createFileRoute('/(sse)/api/sse')({
  server: {
    handlers: {
      GET: ({ request }) => {
        const url = new URL(request.url);
        const spaceId = url.searchParams.get('spaceId') ?? undefined;

        const stream = new ReadableStream({
          start(controller) {
            const encoder = new TextEncoder();

            controller.enqueue(encoder.encode(': connected\n\n'));

            for (const { dockerNodeId, containers } of getAllDockerSnapshots()) {
              const event = { type: 'docker_ps_updated', dockerNodeId, containers };
              controller.enqueue(encoder.encode(`data: ${JSON.stringify(event)}\n\n`));
            }

            const unsubscribe = toastStore.subscribe((data) => {
              try {
                controller.enqueue(encoder.encode(data));
              } catch {
                unsubscribe();
              }
            }, spaceId);

            const keepalive = setInterval(() => {
              try {
                controller.enqueue(encoder.encode(': keepalive\n\n'));
              } catch {
                clearInterval(keepalive);
                unsubscribe();
              }
            }, 30_000);

            const abortHandler = () => {
              clearInterval(keepalive);
              unsubscribe();
              try {
                controller.close();
              } catch {}
            };

            request.signal.addEventListener('abort', abortHandler);
          },
        });

        return new Response(stream, {
          headers: {
            'Content-Type': 'text/event-stream',
            'Cache-Control': 'no-cache, no-transform',
            Connection: 'keep-alive',
          },
        });
      },
    },
  },
});

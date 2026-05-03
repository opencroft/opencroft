import { gateway } from '@/app/(openclaw)/_server/gateway-client';

export const dynamic = 'force-dynamic';

interface RouteParams {
  params: Promise<{ key: string }>;
}

interface KeyedPayload {
  sessionKey?: string;
  message?: unknown;
  reason?: string;
  phase?: string;
}

export async function GET(request: Request, { params }: RouteParams) {
  const { key } = await params;
  const sessionKey = decodeURIComponent(key);
  const encoder = new TextEncoder();

  const stream = new ReadableStream({
    async start(controller) {
      const send = (event: string, data: unknown) => {
        try {
          controller.enqueue(encoder.encode(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`));
        } catch {}
      };

      controller.enqueue(encoder.encode(': connected\n\n'));

      const offMsg = gateway().on('session.message', (payload) => {
        const evt = payload as KeyedPayload;
        if (evt?.sessionKey !== sessionKey) {
          return;
        }
        send('message', evt.message);
      });
      const offTool = gateway().on('session.tool', (payload) => {
        const evt = payload as KeyedPayload;
        if (evt?.sessionKey !== sessionKey) {
          return;
        }
        send('tool', evt);
      });
      const offChanged = gateway().on('sessions.changed', (payload) => {
        const evt = payload as KeyedPayload;
        if (evt?.sessionKey !== sessionKey) {
          return;
        }
        if (evt.phase === 'message') {
          return;
        }
        send('changed', { reason: evt.reason, phase: evt.phase });
      });
      const off = () => {
        offMsg();
        offTool();
        offChanged();
      };

      try {
        await gateway().call('sessions.messages.subscribe', { key: sessionKey });
        await gateway().call('sessions.subscribe', {});
      } catch (error) {
        off();
        send('error', { message: error instanceof Error ? error.message : String(error) });
        controller.close();
        return;
      }

      const keepalive = setInterval(() => {
        try {
          controller.enqueue(encoder.encode(': keepalive\n\n'));
        } catch {
          clearInterval(keepalive);
        }
      }, 30_000);

      request.signal.addEventListener('abort', () => {
        clearInterval(keepalive);
        off();
        gateway().call('sessions.messages.unsubscribe', { key: sessionKey }).catch(() => {});
        gateway().call('sessions.unsubscribe', {}).catch(() => {});
        controller.close();
      });
    },
  });

  return new Response(stream, {
    headers: {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache, no-transform',
      Connection: 'keep-alive',
    },
  });
}

'use client';

import { useLocation, useRouter } from '@tanstack/react-router';
import { useEffect } from 'react';
import { toast } from 'sonner';

import { emitNodeDataUpdate } from '@/app/(dashboard)/_canvas/node-data-events';
import { broadcast as streamBroadcast, getStream } from '@/app/(extension-runtime)/_client/stream';
import { useSSEEventsDispatch } from '@/app/(sse)/stores/sse-events-store';
import type { SSEEvent } from '@/lib/sse-events';

function extractSlug(pathname: string | null): string | null {
  if (!pathname) {
    return null;
  }
  const match = pathname.match(/^\/space\/([^/]+)/);
  return match ? decodeURIComponent(match[1]) : null;
}

export function useSSE() {
  const dispatch = useSSEEventsDispatch();
  const pathname = useLocation({ select: (l) => l.pathname });
  const router = useRouter();
  const slug = extractSlug(pathname);

  useEffect(() => {
    const url = slug ? `/api/sse?spaceId=${encodeURIComponent(slug)}` : '/api/sse';
    const evtSource = new EventSource(url);

    evtSource.onmessage = (event) => {
      try {
        const data = JSON.parse(event.data) as SSEEvent;

        if (data.type === 'toast') {
          const fn = toast[data.toastType] || toast.info;
          fn(data.message, { duration: 5000 });
        }

        if (data.type === 'open_space') {
          router.navigate({ to: `/space/${data.slug}` });
        }

        if (data.type === 'stream_chunk') {
          streamBroadcast(getStream(data.nodeId, data.handleId), data.chunk);
        }

        if (data.type === 'node_data_updated') {
          emitNodeDataUpdate(data.nodeId, data.data);
        }

        dispatch(data);
      } catch {
        // ignore non-JSON messages (keepalive comments)
      }
    };

    evtSource.onerror = () => {
      // EventSource auto-reconnects on error
    };

    return () => {
      evtSource.close();
    };
  }, [slug, dispatch, router]);
}

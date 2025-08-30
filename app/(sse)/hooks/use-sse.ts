'use client';

import { usePathname, useRouter } from 'next/navigation';
import { useEffect } from 'react';
import { toast } from 'sonner';

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
  const pathname = usePathname();
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
          router.push(`/space/${data.slug}`);
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

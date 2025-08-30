'use client';

import { useSSE } from '@/app/(sse)/hooks/use-sse';
import { SSEEventsProvider } from '@/app/(sse)/stores/sse-events-store';

export function SSEProvider({ children }: { children: React.ReactNode }) {
  return (
    <SSEEventsProvider>
      <SSEListener />
      {children}
    </SSEEventsProvider>
  );
}

/** Inner component that opens the EventSource connection. */
function SSEListener() {
  useSSE();
  return null;
}

'use client';

import { createContext, type ReactNode } from 'react';

/**
 * Pushes feature content (diff view, AI chat panel, etc.) into the Canvas's
 * scrollable working area above the sticky command bar. Pass `null` to clear.
 */
export const CanvasContentContext = createContext<(node: ReactNode) => void>(() => {});

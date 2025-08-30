// ── SSE Events Store (client-side) ──────────────────────────────────────
//
// Simple store for graph-level events received via SSE.
// Components subscribe to specific event types using the useSSEEvents hook.

'use client';

import { createContext, useCallback, useContext, useRef, useSyncExternalStore } from 'react';

import type { Comment, DockerContainerSnapshot, PendingApproval, SSEEvent } from '@/lib/sse-events';

// ── State ───────────────────────────────────────────────────────────────

interface SSEEventsState {
  /** Latest focus_node event (null when cleared). */
  focusedNodeId: string | null;
  /** Active comments keyed by nodeId (one per node). */
  comments: Map<string, Comment>;
  /** Bumped whenever the server announces a graph mutation. */
  graphVersion: number;
  /** Bumped whenever the server announces an extension mutation. */
  extensionsVersion: number;
  /** Per-doc version bumped whenever a doc's comments change. */
  docCommentsVersion: Map<string, number>;
  /** Pending MCP approval requests keyed by request id. */
  pendingApprovals: Map<string, PendingApproval>;
  /** Currently selected pending approval id (drives the command bar approval state). */
  selectedApprovalId: string | null;
  /** Bumped on every focus_node dispatch so consumers can re-trigger even on the same id. */
  focusVersion: number;
  /** Latest container snapshots keyed by dockerNodeId. */
  dockerContainers: Map<string, DockerContainerSnapshot[]>;
}

function createInitialState(): SSEEventsState {
  return {
    focusedNodeId: null,
    comments: new Map(),
    graphVersion: 0,
    extensionsVersion: 0,
    docCommentsVersion: new Map(),
    pendingApprovals: new Map(),
    selectedApprovalId: null,
    focusVersion: 0,
    dockerContainers: new Map(),
  };
}

// ── Store ───────────────────────────────────────────────────────────────

class SSEEventsStore {
  private state: SSEEventsState = createInitialState();
  private listeners = new Set<() => void>();

  subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  };

  private emit = () => {
    for (const fn of this.listeners) {
      fn();
    }
  };

  getSnapshot = (): SSEEventsState => this.state;

  /** Process an incoming SSE event and update state. */
  dispatch = (event: SSEEvent): void => {
    switch (event.type) {
      case 'focus_node':
        this.state = {
          ...this.state,
          focusedNodeId: event.nodeId,
          focusVersion: this.state.focusVersion + 1,
        };
        break;
      case 'clear_focus':
        this.state = { ...this.state, focusedNodeId: null };
        break;
      case 'comment':
        this.state = {
          ...this.state,
          comments: new Map(this.state.comments).set(event.nodeId, {
            nodeId: event.nodeId,
            message: event.message,
          }),
        };
        break;
      case 'clear_comment': {
        const next = new Map(this.state.comments);
        next.delete(event.nodeId);
        this.state = { ...this.state, comments: next };
        break;
      }
      case 'graph_updated':
        this.state = { ...this.state, graphVersion: this.state.graphVersion + 1 };
        break;
      case 'extensions_updated':
        this.state = { ...this.state, extensionsVersion: this.state.extensionsVersion + 1 };
        break;
      case 'doc_comments_updated': {
        const versions = new Map(this.state.docCommentsVersion);
        versions.set(event.docPath, (versions.get(event.docPath) ?? 0) + 1);
        this.state = { ...this.state, docCommentsVersion: versions };
        break;
      }
      case 'approval_pending': {
        const next = new Map(this.state.pendingApprovals);
        next.set(event.request.id, event.request);
        const selected = this.state.selectedApprovalId ?? event.request.id;
        this.state = { ...this.state, pendingApprovals: next, selectedApprovalId: selected };
        break;
      }
      case 'approval_resolved': {
        const next = new Map(this.state.pendingApprovals);
        next.delete(event.id);
        let selected = this.state.selectedApprovalId;
        if (selected === event.id || !selected || !next.has(selected)) {
          selected = next.values().next().value?.id ?? null;
        }
        this.state = { ...this.state, pendingApprovals: next, selectedApprovalId: selected };
        break;
      }
      case 'docker_ps_updated': {
        const next = new Map(this.state.dockerContainers);
        next.set(event.dockerNodeId, event.containers);
        this.state = { ...this.state, dockerContainers: next };
        break;
      }
      case 'toast':
        // Handled by useSSE directly (sonner), nothing to store.
        return;
    }
    this.emit();
  };

  /** Replace the pending-approvals snapshot (used after an initial fetch). */
  setPendingApprovals = (requests: PendingApproval[]): void => {
    const next = new Map<string, PendingApproval>();
    for (const r of requests) {
      next.set(r.id, r);
    }
    const stillValid = this.state.selectedApprovalId && next.has(this.state.selectedApprovalId)
      ? this.state.selectedApprovalId
      : null;
    const first = requests[0]?.id ?? null;
    const selected = stillValid ?? first;
    this.state = { ...this.state, pendingApprovals: next, selectedApprovalId: selected };
    this.emit();
  };

  /** Select (or clear) a pending approval to drive the command bar approval state. */
  setSelectedApproval = (id: string | null): void => {
    if (this.state.selectedApprovalId === id) {
      return;
    }
    this.state = { ...this.state, selectedApprovalId: id };
    this.emit();
  };

  /** Seed container snapshot from an initial fetch (e.g. on node mount). */
  setDockerContainers = (dockerNodeId: string, containers: DockerContainerSnapshot[]): void => {
    const next = new Map(this.state.dockerContainers);
    next.set(dockerNodeId, containers);
    this.state = { ...this.state, dockerContainers: next };
    this.emit();
  };
}

// Singleton
const sseEventsStore = new SSEEventsStore();

/** Access the store directly (outside of React context, e.g. from API routes). */
export { sseEventsStore };

// ── Context (for React tree access) ─────────────────────────────────────

const SSEEventsContext = createContext<SSEEventsStore | null>(null);

export function SSEEventsProvider({ children }: { children: React.ReactNode }) {
  // Store the singleton in context so any subtree can access it.
  // The store itself is a module-level singleton — context is just for discoverability.
  return (
    <SSEEventsContext.Provider value={sseEventsStore}>
      {children}
    </SSEEventsContext.Provider>
  );
}

function useSSEEventsStore(): SSEEventsStore {
  const store = useContext(SSEEventsContext);
  if (!store) {
    throw new Error('useSSEEvents must be used within SSEEventsProvider');
  }
  return store;
}

// ── Hooks ───────────────────────────────────────────────────────────────

// Cached server snapshots — must be stable references to avoid infinite re-renders
const SERVER_COMMENTS = new Map<string, Comment>();
const SERVER_DOC_COMMENTS_VERSION = new Map<string, number>();
const SERVER_PENDING_APPROVALS = new Map<string, PendingApproval>();
const SERVER_DOCKER_CONTAINERS = new Map<string, DockerContainerSnapshot[]>();
const SERVER_STATE: SSEEventsState = {
  focusedNodeId: null,
  comments: SERVER_COMMENTS,
  graphVersion: 0,
  extensionsVersion: 0,
  docCommentsVersion: SERVER_DOC_COMMENTS_VERSION,
  pendingApprovals: SERVER_PENDING_APPROVALS,
  selectedApprovalId: null,
  focusVersion: 0,
  dockerContainers: SERVER_DOCKER_CONTAINERS,
};

/**
 * Subscribe to SSE graph events (focus, comments, etc.).
 * Returns the current state snapshot.
 */
export function useSSEEvents(): SSEEventsState {
  const store = useSSEEventsStore();
  // useSyncExternalStore handles tear-free concurrent reads.
  const state = useSyncExternalStore(
    store.subscribe,
    () => store.getSnapshot(),
    () => SERVER_STATE,
  );

  return state;
}

/**
 * Get a stable dispatch function for SSE events.
 * Useful if you need to dispatch events from components.
 */
export function useSSEEventsDispatch(): (event: SSEEvent) => void {
  const store = useSSEEventsStore();
  const dispatchRef = useRef(store.dispatch);
  dispatchRef.current = store.dispatch;
  return useCallback((event: SSEEvent) => dispatchRef.current(event), []);
}

const EMPTY_CONTAINERS: DockerContainerSnapshot[] = [];

/**
 * Subscribe to the latest container snapshot for a docker node, optionally
 * filtered by compose service name. Returns an empty array when no snapshot
 * has been received yet.
 */
export function useDockerContainers(
  dockerNodeId: string | null | undefined,
  service?: string,
): DockerContainerSnapshot[] {
  const { dockerContainers } = useSSEEvents();
  if (!dockerNodeId) {
    return EMPTY_CONTAINERS;
  }
  const all = dockerContainers.get(dockerNodeId);
  if (!all) {
    return EMPTY_CONTAINERS;
  }
  if (!service) {
    return all;
  }
  return all.filter((c) => c.service === service);
}

/** Seed the store with an initial snapshot (typically from invoke('docker.ps')). */
export function useSeedDockerContainers(): (dockerNodeId: string, containers: DockerContainerSnapshot[]) => void {
  const store = useSSEEventsStore();
  return useCallback(
    (dockerNodeId, containers) => store.setDockerContainers(dockerNodeId, containers),
    [store],
  );
}

/** Whether a docker_ps snapshot has been received for this node (even if empty). */
export function useDockerSnapshotReceived(dockerNodeId: string | null | undefined): boolean {
  const { dockerContainers } = useSSEEvents();
  if (!dockerNodeId) {
    return false;
  }
  return dockerContainers.has(dockerNodeId);
}

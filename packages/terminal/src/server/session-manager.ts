import { randomUUID } from 'node:crypto'

/** Minimal peer surface the manager needs — satisfied by crossws `Peer`. */
export interface SocketPeer {
  send(data: string): void
}

/**
 * Transport-agnostic handle for a live shell — a `pty.IPty` or an `SshShell` adapted to this
 * shape by socket.ts. The manager only ever talks to sessions through this interface, which is
 * what makes it independently testable (a fake handle backed by a real child process stands in
 * for a pty in tests, with no native bindings or ssh2 involved).
 */
export interface SessionHandle {
  onData(fn: (data: string) => void): void
  onExit(fn: () => void): void
  write(data: string): void
  resize(cols: number, rows: number): void
  kill(): void
  isAlive(): boolean
}

export type KillReason = 'explicit' | 'ttl' | 'evicted' | 'exit'

/**
 * What a session is for. `interactive` is a shell somebody is typing into; `job` is a command
 * started by server code that a client may watch.
 *
 * The distinction exists to keep them out of each other's way: the two kinds have separate
 * capacity, so no number of jobs can cost a person the terminal they have open. See
 * `reserveSlot`.
 */
export type SessionKind = 'interactive' | 'job'

export interface ManagedSession {
  id: string
  handle: SessionHandle
  scrollback: ScrollbackBuffer
  attachedPeer: SocketPeer | null
  createdAt: number
  detachedAt: number | null
  sessionKey?: string
  /** false ⇒ legacy client (no sessionKey): killed on socket close instead of detached. */
  persistent: boolean
  kind: SessionKind
}

export const DETACHED_TTL_MS = 15 * 60 * 1000
export const SWEEP_INTERVAL_MS = 30 * 1000
export const MAX_SESSIONS = 20
/**
 * Jobs are capped separately from interactive sessions rather than sharing `MAX_SESSIONS`.
 * A shared budget would make "someone's open terminal disappeared because a build started" a
 * reachable state — a burst of deploys filling the pool, then evicting the oldest detached
 * session to make room. Separate budgets make it unreachable rather than unlikely.
 */
export const MAX_JOB_SESSIONS = 10
export const MAX_SCROLLBACK_BYTES = 512 * 1024

/** Bounded byte ring buffer for scrollback replay — drops the oldest bytes once over cap. */
export class ScrollbackBuffer {
  private chunks: Buffer[] = []
  private total = 0

  constructor(private readonly maxBytes: number) {}

  push(data: string): void {
    if (this.maxBytes <= 0) {
      return
    }
    const buf = Buffer.from(data, 'utf8')
    this.chunks.push(buf)
    this.total += buf.length
    while (this.total > this.maxBytes && this.chunks.length > 0) {
      const first = this.chunks[0]
      if (!first) {
        break
      }
      const excess = this.total - this.maxBytes
      if (excess >= first.length) {
        this.chunks.shift()
        this.total -= first.length
      } else {
        this.chunks[0] = first.subarray(excess)
        this.total -= excess
      }
    }
  }

  toString(): string {
    return Buffer.concat(this.chunks).toString('utf8')
  }
}

export interface SessionManagerOptions {
  detachedTtlMs?: number
  sweepIntervalMs?: number
  maxSessions?: number
  /** Cap on server-started job sessions, counted separately from interactive ones. */
  maxJobSessions?: number
  maxScrollbackBytes?: number
  /** Injectable clock, for TTL tests. */
  now?: () => number
  /** One-line-per-event logger. Defaults to `console.log`. */
  log?: (line: string) => void
  /** Injectable transport, so tests can capture sent messages without a real peer. */
  sendToPeer?: (peer: SocketPeer, message: { type: string; payload: Record<string, unknown> }) => void
}

export type ConnectDecision =
  | { kind: 'reattached'; session: ManagedSession }
  | { kind: 'create' }
  | { kind: 'refused'; message: string }

/**
 * Server-owned registry of live shell sessions, keyed by sessionId and (optionally) by an opaque
 * client-supplied sessionKey. Peers attach/detach; sessions outlive a single socket connection.
 *
 * Every method that removes a session (`kill`) is the single choke point that stops the
 * underlying process/channel AND removes the map entry AND clears any peer→session pointers, in
 * that order, synchronously — so a ManagedSession can never outlive its process, and a process
 * can never outlive its manager entry. The only timer here is the one global sweep interval;
 * there are no per-session timers to leak.
 */
export class SessionManager {
  private readonly sessions = new Map<string, ManagedSession>()
  private readonly peerSession = new Map<SocketPeer, string>()
  private readonly sweepTimer: ReturnType<typeof setInterval>

  private readonly detachedTtlMs: number
  private readonly maxSessions: number
  private readonly maxJobSessions: number
  private readonly maxScrollbackBytes: number
  private readonly now: () => number
  private readonly log: (line: string) => void
  private readonly sendToPeer: (peer: SocketPeer, message: { type: string; payload: Record<string, unknown> }) => void

  constructor(opts: SessionManagerOptions = {}) {
    this.detachedTtlMs = opts.detachedTtlMs ?? DETACHED_TTL_MS
    this.maxSessions = opts.maxSessions ?? MAX_SESSIONS
    this.maxJobSessions = opts.maxJobSessions ?? MAX_JOB_SESSIONS
    this.maxScrollbackBytes = opts.maxScrollbackBytes ?? MAX_SCROLLBACK_BYTES
    this.now = opts.now ?? (() => Date.now())
    this.log = opts.log ?? ((line: string) => console.log(`[terminal-session] ${line}`))
    this.sendToPeer = opts.sendToPeer ?? ((peer, message) => peer.send(JSON.stringify(message)))

    const intervalMs = opts.sweepIntervalMs ?? SWEEP_INTERVAL_MS
    this.sweepTimer = setInterval(() => this.sweep(), intervalMs)
    this.sweepTimer.unref?.()
  }

  /** Stops the sweeper. For tests/shutdown — does not touch live sessions. */
  dispose(): void {
    clearInterval(this.sweepTimer)
  }

  size(): number {
    return this.sessions.size
  }

  get(id: string): ManagedSession | undefined {
    return this.sessions.get(id)
  }

  getSessionForPeer(peer: SocketPeer): ManagedSession | undefined {
    const id = this.peerSession.get(peer)
    return id ? this.sessions.get(id) : undefined
  }

  private findByKey(key: string): ManagedSession | undefined {
    for (const session of this.sessions.values()) {
      if (session.sessionKey === key) {
        return session
      }
    }
    return undefined
  }

  /**
   * Whether a session may be reclaimed to make room, or aged out by the sweeper.
   *
   * Being detached is what marks an interactive shell as abandoned — nobody is typing into it,
   * and killing it costs at most some scrollback. A job is different in the one way that matters:
   * it is created detached, because it starts before anyone is watching, and reclaiming one means
   * killing a deploy that is still running. So a job is reclaimable only once its process has
   * exited, at which point it is what these policies were written for — stale output nobody came
   * back for.
   */
  private isReclaimable(session: ManagedSession): boolean {
    if (session.detachedAt === null) {
      return false
    }
    return !(session.kind === 'job' && session.handle.isAlive())
  }

  private countOfKind(kind: SessionKind): number {
    let count = 0
    for (const session of this.sessions.values()) {
      if (session.kind === kind) {
        count++
      }
    }
    return count
  }

  /**
   * Make room for one more session OF THIS KIND, counting and evicting only within that kind.
   *
   * The scoping is the whole point and is not an optimisation: a job must never be able to take
   * capacity from, or evict, an interactive session. Someone watching a build start must not
   * lose the shell they had open in another tab. Counting across both kinds would allow exactly
   * that, and no amount of headroom would rule it out — only the separation does.
   */
  private reserveSlot(kind: SessionKind): { ok: true } | { ok: false; message: string } {
    const limit = kind === 'job' ? this.maxJobSessions : this.maxSessions
    if (this.countOfKind(kind) < limit) {
      return { ok: true }
    }
    let oldest: ManagedSession | undefined
    for (const session of this.sessions.values()) {
      if (session.kind !== kind) {
        continue
      }
      if (session.detachedAt === null || !this.isReclaimable(session)) {
        continue
      }
      if (!oldest || session.detachedAt < (oldest.detachedAt as number)) {
        oldest = session
      }
    }
    if (oldest) {
      this.kill(oldest.id, 'evicted', 'Evicted to make room for a new session')
      return { ok: true }
    }
    return {
      ok: false,
      message: `Session limit reached (${limit} active); close another session and retry.`,
    }
  }

  /**
   * Decide what a `connect`/`local`/`wsl` message should do before the caller spawns anything:
   * reattach to a detached same-key session (no spawn needed), kill-and-replace a live same-key
   * session then clear the way for a fresh spawn, or refuse outright when at capacity with
   * nothing evictable. Callers must not spawn a process when this returns anything but `create`.
   */
  prepareConnect(peer: SocketPeer, sessionKey: string | undefined, cols: number, rows: number): ConnectDecision {
    if (sessionKey) {
      const existing = this.findByKey(sessionKey)
      if (existing) {
        if (existing.detachedAt !== null) {
          this.doAttach(existing, peer, cols, rows)
          return { kind: 'reattached', session: existing }
        }
        this.kill(existing.id, 'evicted', 'Session replaced by another connection')
      }
    }
    const slot = this.reserveSlot('interactive')
    if (!slot.ok) {
      return { kind: 'refused', message: slot.message }
    }
    return { kind: 'create' }
  }

  /**
   * Reserve capacity for a server-started job, before spawning it. Jobs have no `prepareConnect`
   * step of their own — nothing reattaches to a job that does not exist yet — so this is the
   * whole admission check.
   */
  prepareJob(): { ok: true } | { ok: false; message: string } {
    return this.reserveSlot('job')
  }

  /**
   * Register a freshly spawned session, attached to `peer` from the start.
   *
   * `peer` is null for a session nobody is watching yet — a job started by server code, which a
   * client attaches to later by key.
   */
  create(
    peer: SocketPeer | null,
    handle: SessionHandle,
    opts: { sessionKey?: string; id?: string; kind?: SessionKind } = {},
  ): ManagedSession {
    const id = opts.id ?? randomUUID()
    const persistent = !!opts.sessionKey

    // `prepareConnect`'s same-key check and this insertion are separated by an async spawn/dial
    // (the caller decides 'create', then awaits pty.spawn/sshShell, then calls this) — two
    // concurrent connects for the same sessionKey (two tabs, or a reconnect racing a still-in-flight
    // dial) can both observe "no existing session" and both reach here. Re-check at the actual,
    // synchronous insertion point and kill any session that slipped in during that gap, so the
    // invariant "at most one live session per key" holds regardless of interleaving — otherwise the
    // loser's handle would stay registered but unreachable (peerSession only ever points at one id).
    if (opts.sessionKey) {
      const stale = this.findByKey(opts.sessionKey)
      if (stale) {
        this.kill(stale.id, 'evicted', 'Session replaced by another connection')
      }
    }

    const managed: ManagedSession = {
      id,
      handle,
      scrollback: new ScrollbackBuffer(this.maxScrollbackBytes),
      attachedPeer: peer,
      createdAt: this.now(),
      // A job starts detached: it is running and nobody is watching yet. The detached TTL is a
      // backstop rather than the mechanism that reclaims it — `create` registers an exit callback
      // that kills the session the moment the child closes, so a finished job is normally gone
      // long before any TTL applies to it.
      detachedAt: peer ? null : this.now(),
      sessionKey: opts.sessionKey,
      persistent,
      kind: opts.kind ?? 'interactive',
    }

    handle.onData((data) => {
      managed.scrollback.push(data)
      if (managed.attachedPeer) {
        this.sendToPeer(managed.attachedPeer, { type: 'data', payload: { data } })
      }
    })
    handle.onExit(() => this.kill(id, 'exit'))

    this.sessions.set(id, managed)
    if (peer) {
      this.peerSession.set(peer, id)
    }
    this.log(`create id=${id} key=${opts.sessionKey ?? '-'} persistent=${persistent} kind=${managed.kind}`)
    return managed
  }

  /** Handle a client `attach { sessionId?, sessionKey? }` message (explicit reconnect). */
  attach(
    peer: SocketPeer,
    opts: { sessionId?: string; sessionKey?: string; cols: number; rows: number },
  ): { ok: true; session: ManagedSession } | { ok: false } {
    const { sessionId, sessionKey, cols, rows } = opts
    let session: ManagedSession | undefined
    if (sessionId) {
      session = this.sessions.get(sessionId)
    }
    if (!session && sessionKey) {
      session = this.findByKey(sessionKey)
    }
    if (!session) {
      return { ok: false }
    }
    this.doAttach(session, peer, cols, rows)
    return { ok: true, session }
  }

  private doAttach(session: ManagedSession, peer: SocketPeer, cols: number, rows: number): void {
    const backlog = session.scrollback.toString()
    if (backlog) {
      this.sendToPeer(peer, { type: 'data', payload: { data: backlog } })
    }
    session.attachedPeer = peer
    session.detachedAt = null
    this.peerSession.set(peer, session.id)
    try {
      session.handle.resize(cols, rows)
    } catch {
      /* best-effort repaint trigger */
    }
    this.log(`attach id=${session.id} key=${session.sessionKey ?? '-'}`)
  }

  /** Client `data`/`resize` messages route here via the peer→session lookup. */
  write(peer: SocketPeer, data: string): void {
    this.getSessionForPeer(peer)?.handle.write(data)
  }

  resize(peer: SocketPeer, cols: number, rows: number): void {
    this.getSessionForPeer(peer)?.handle.resize(cols, rows)
  }

  /** Client `disconnect` message: always kills, regardless of sessionKey. */
  killByPeer(peer: SocketPeer): void {
    const id = this.peerSession.get(peer)
    this.peerSession.delete(peer)
    if (!id) {
      return
    }
    const session = this.sessions.get(id)
    if (session && session.attachedPeer === peer) {
      this.kill(id, 'explicit')
    }
  }

  /** Socket close: detach persistent (keyed) sessions, kill legacy (unkeyed) ones. */
  handleSocketClose(peer: SocketPeer): void {
    const id = this.peerSession.get(peer)
    this.peerSession.delete(peer)
    if (!id) {
      return
    }
    const session = this.sessions.get(id)
    if (!session || session.attachedPeer !== peer) {
      return
    }
    if (!session.persistent) {
      this.kill(id, 'explicit', undefined, 'legacy-close')
      return
    }
    session.attachedPeer = null
    session.detachedAt = this.now()
    this.log(`detach id=${id} key=${session.sessionKey ?? '-'}`)
  }

  /**
   * The single choke point for ending a session: stops the process/channel, notifies the
   * attached peer (if any and if a message applies), then removes the session and every
   * peer→session pointer to it. Safe to call on an already-removed id (no-op).
   */
  kill(id: string, reason: KillReason, notifyMessage?: string, context?: string): void {
    const session = this.sessions.get(id)
    if (!session) {
      return
    }
    try {
      session.handle.kill()
    } catch {
      /* best-effort */
    }
    if (session.attachedPeer) {
      const message = notifyMessage ?? (reason === 'exit' ? 'Shell exited' : undefined)
      if (message) {
        this.sendToPeer(session.attachedPeer, { type: 'disconnected', payload: { reason: message } })
      }
    }
    this.sessions.delete(id)
    for (const [peer, sid] of this.peerSession) {
      if (sid === id) {
        this.peerSession.delete(peer)
      }
    }
    const suffix = context ? ` (${context})` : ''
    this.log(`kill id=${id} key=${session.sessionKey ?? '-'} reason=${reason}${suffix}`)
  }

  private sweep(): void {
    const now = this.now()
    let killed = 0
    for (const session of [...this.sessions.values()]) {
      if (!session.handle.isAlive()) {
        this.kill(session.id, 'exit', undefined, 'sweep-dead-process')
        killed++
        continue
      }
      if (session.detachedAt !== null && this.isReclaimable(session) && now - session.detachedAt > this.detachedTtlMs) {
        this.kill(session.id, 'ttl')
        killed++
      }
    }
    if (killed > 0) {
      this.log(`sweep killed=${killed} remaining=${this.sessions.size}`)
    }
  }
}

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
  /**
   * When a job's command ended, or null while it runs. Always null for interactive sessions.
   *
   * An ended job is kept as a read-only record of its output: it has no watcher, a newcomer gets
   * the output and the end and is not bound to it, and it is reclaimed by the detached TTL counted
   * from this moment. See `endJob`.
   */
  endedAt: number | null
  /** A job's `stopWhenUnwatchedMs` — see JobSessionOptions. */
  stopWhenUnwatchedMs?: number
}

/** What every watcher of a job, then and later, is told when its command has ended. */
export const JOB_ENDED_REASON = 'Job finished'

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
  /** Cap on ended jobs kept for replay; the oldest is dropped past it. Defaults to maxJobSessions. */
  maxEndedJobSessions?: number
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
  /** The key named an ended job, and its output and end have already been sent to the peer. */
  | { kind: 'ended' }

/**
 * Server-owned registry of live shell sessions, keyed by sessionId and (optionally) by an opaque
 * client-supplied sessionKey. Peers attach/detach; sessions outlive a single socket connection.
 *
 * Every method that removes a session (`kill`) is the single choke point that stops the
 * underlying process/channel AND removes the map entry AND clears any peer→session pointers, in
 * that order, synchronously — so a process can never outlive its manager entry. The one entry
 * that outlives its process is an ended job, kept on purpose as a read-only record of its output
 * until the TTL (see `endJob`). The only timer here is the one global sweep interval; there are
 * no per-session timers to leak.
 */
export class SessionManager {
  private readonly sessions = new Map<string, ManagedSession>()
  private readonly peerSession = new Map<SocketPeer, string>()
  private readonly sweepTimer: ReturnType<typeof setInterval>

  private readonly detachedTtlMs: number
  private readonly maxSessions: number
  private readonly maxJobSessions: number
  private readonly maxEndedJobSessions: number
  private readonly maxScrollbackBytes: number
  private readonly now: () => number
  private readonly log: (line: string) => void
  private readonly sendToPeer: (peer: SocketPeer, message: { type: string; payload: Record<string, unknown> }) => void

  constructor(opts: SessionManagerOptions = {}) {
    this.detachedTtlMs = opts.detachedTtlMs ?? DETACHED_TTL_MS
    this.maxSessions = opts.maxSessions ?? MAX_SESSIONS
    this.maxJobSessions = opts.maxJobSessions ?? MAX_JOB_SESSIONS
    this.maxEndedJobSessions = opts.maxEndedJobSessions ?? this.maxJobSessions
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

  // Ended jobs are records, not running commands, and have a cap of their own (`endJob`), so they
  // take no part in the capacity for running ones — neither counted nor evicted to make room.
  private countLive(kind: SessionKind): number {
    let count = 0
    for (const session of this.sessions.values()) {
      if (session.kind === kind && session.endedAt === null) {
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
    if (this.countLive(kind) < limit) {
      return { ok: true }
    }
    let oldest: ManagedSession | undefined
    for (const session of this.sessions.values()) {
      if (session.kind !== kind || session.endedAt !== null) {
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

  // ── A client reaching a live job: three doors, one rule ──
  //
  // The rule is stated over the class rather than at one entry point, because a client holding a
  // session key arrives through three of them, and a guard that holds at one is a speed bump
  // rather than an invariant:
  //
  //   prepareConnect     a `connect` carrying the job's key
  //   attach             an explicit `attach { sessionId?, sessionKey? }`
  //   handleDisconnect   the client's `disconnect`
  //
  // THE RULE: a client may take over the watch on a job; it may never end the command. Arriving
  // takes the watch from whoever held it — `doAttach` reassigns the peer and replays scrollback
  // without touching the handle — and leaving gives up the watch and nothing else.
  //
  // Refusing a second watcher was the first version of this and it was wrong from both sides.
  // `attach` admitted the same client anyway, with the same key, so the refusal never was an
  // invariant. And the incumbent it protected is usually a socket that has not noticed it is gone,
  // so it locked a person out of watching their own deploy after a network blip, until the server
  // timed the dead socket out. Taking over protects the command AND the watcher; refusing protects
  // only the command.
  //
  // There is deliberately no client-facing way to stop a job: one ends when it exits, when its
  // bound expires, or when server code kills it. A cancel, if one is ever wanted, needs its own
  // message with its own authority rather than the watch channel — which is why `handleDisconnect`
  // detaches instead of growing a special case.
  //
  // Interactive sessions keep kill-and-replace at `prepareConnect`. That predates this work and
  // nothing here is evidence about it; leaving it is a decision, not an omission.

  /**
   * Decide what a `connect`/`local`/`wsl` message should do before the caller spawns anything:
   * reattach to a detached same-key session (no spawn needed), take over a live job, kill-and-
   * replace a live same-key interactive session then clear the way for a fresh spawn, or refuse
   * outright when at capacity with nothing evictable. Callers must not spawn a process when this
   * returns anything but `create`.
   *
   * A key naming an ENDED job is answered like `attach` answers it — output, then the end — and
   * the caller spawns nothing. An ended job is never replaced by a fresh session under its key.
   */
  prepareConnect(peer: SocketPeer, sessionKey: string | undefined, cols: number, rows: number): ConnectDecision {
    if (sessionKey) {
      const existing = this.findByKey(sessionKey)
      if (existing?.endedAt != null) {
        this.replayEnded(existing, peer)
        return { kind: 'ended' }
      }
      if (existing) {
        // Four cases, and they are written out because the job column is the one that ends a
        // running deploy if it is got wrong:
        //
        //  interactive + detached  reattach. The tab came back; this is the whole point of a key.
        //  interactive + live      kill and replace. At most one live session per key, and the
        //                          newcomer wins: the incumbent is usually a socket that has not
        //                          noticed it is gone, and the shell is replaceable anyway.
        //  job + detached          attach and watch. This is how a deploy gets watched at all.
        //  job + live              attach and TAKE OVER the watch — never kill-and-replace, because
        //                          "replace" on a job means killing the command, and a deploy is not
        //                          a shell: the client cannot start another one, and the work that
        //                          was already done does not come back.
        //
        // So both job rows are the same action, and the condition says so rather than reaching the
        // same place twice. See the class note above for why this takes over rather than refusing.
        if (existing.detachedAt !== null || existing.kind === 'job') {
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
   *
   * **It reserves nothing, and that is a decision rather than an oversight.** The name is
   * historical: this counts live sessions of the kind and may evict one, so the answer is true at
   * the instant it is given and not after. The caller then awaits a spawn or a network dial before
   * reaching `create`, so two job starts at 9 of 10 can both be admitted and both create.
   *
   * `create` re-checks the OTHER invariant it guards — one live session per key — at the
   * synchronous insertion point, and the asymmetry is deliberate. Two sessions on one key leave the
   * loser's handle registered and unreachable, because `peerSession` only ever points at one id:
   * a leak that never resolves itself. Two jobs over the cap cost bounded extra memory and
   * connections, and the next `prepareJob` sees the true count and refuses — the overshoot drains.
   * Closing it properly means holding a real reservation, which needs its own release on every
   * failure path and a reaper for the ones whose owner died first: a permanent leak of a different
   * kind, traded for a bound that is advisory.
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
    opts: { sessionKey?: string; id?: string; kind?: SessionKind; stopWhenUnwatchedMs?: number } = {},
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
      // A job starts detached: it is running and nobody is watching yet. A running job is never
      // reclaimed by the TTL (see isReclaimable); once it ends, the TTL counts from the end.
      detachedAt: peer ? null : this.now(),
      sessionKey: opts.sessionKey,
      persistent,
      kind: opts.kind ?? 'interactive',
      endedAt: null,
      stopWhenUnwatchedMs: opts.stopWhenUnwatchedMs,
    }

    handle.onData((data) => {
      managed.scrollback.push(data)
      if (managed.attachedPeer) {
        this.sendToPeer(managed.attachedPeer, { type: 'data', payload: { data } })
      }
    })

    this.sessions.set(id, managed)
    if (peer) {
      this.peerSession.set(peer, id)
    }
    this.log(`create id=${id} key=${opts.sessionKey ?? '-'} persistent=${persistent} kind=${managed.kind}`)
    // Registered after the session is: a stream handle whose command has already ended calls a
    // late exit listener at once, and the job has to be found to be marked ended.
    handle.onExit(() => (managed.kind === 'job' ? this.endJob(id) : this.kill(id, 'exit')))
    return managed
  }

  /**
   * Handle a client `attach { sessionId?, sessionKey? }` message (explicit reconnect).
   *
   * Takeover, for both kinds — and for a job that IS the disposition, stated here rather than left
   * to be inferred from the absence of a kind check. `doAttach` reassigns the watching peer and
   * replays scrollback without touching the handle, so the command runs on regardless of who is
   * watching it. This door is why refusing at `prepareConnect` never was an invariant; the two now
   * agree. See the class note above `prepareConnect`.
   */
  attach(
    peer: SocketPeer,
    opts: { sessionId?: string; sessionKey?: string; cols: number; rows: number },
  ): { ok: true; session: ManagedSession; ended: boolean } | { ok: false } {
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
    if (session.endedAt !== null) {
      this.replayEnded(session, peer)
      return { ok: true, session, ended: true }
    }
    this.doAttach(session, peer, cols, rows)
    return { ok: true, session, ended: false }
  }

  /**
   * A job's command has ended: tell its watcher, let go of it, and keep the output to replay.
   *
   * The watcher is unbound here rather than left attached, because an attached session is never
   * reclaimed — a tab left open on a finished log would otherwise hold its record forever. From
   * here on every door (`attach`, `prepareConnect`) answers with the output and this same end, and
   * binds nothing, so the TTL counted from this moment is the one that applies.
   *
   * Past the retention cap the oldest ended job is dropped. A viewer that ends at once — the last
   * lines of a stopped container's log — would otherwise leave a full scrollback behind on every
   * open, for the whole TTL.
   */
  private endJob(id: string): void {
    const session = this.sessions.get(id)
    if (!session || session.endedAt !== null) {
      return
    }
    const now = this.now()
    session.endedAt = now
    if (session.attachedPeer) {
      this.sendToPeer(session.attachedPeer, { type: 'disconnected', payload: { reason: JOB_ENDED_REASON } })
    }
    session.attachedPeer = null
    session.detachedAt = now
    this.unbindPeersOf(id)
    this.log(`end id=${id} key=${session.sessionKey ?? '-'}`)
    this.dropEndedJobsOverCap()
  }

  private dropEndedJobsOverCap(): void {
    const ended = [...this.sessions.values()]
      .filter((session) => session.endedAt !== null)
      .sort((a, b) => (a.endedAt as number) - (b.endedAt as number))
    for (const session of ended.slice(0, Math.max(0, ended.length - this.maxEndedJobSessions))) {
      this.kill(session.id, 'evicted', undefined, 'ended-job cap')
    }
  }

  /** Output first, then the end a live watcher got. The peer is not bound and the TTL runs on. */
  private replayEnded(session: ManagedSession, peer: SocketPeer): void {
    const backlog = session.scrollback.toString()
    if (backlog) {
      this.sendToPeer(peer, { type: 'data', payload: { data: backlog } })
    }
    this.sendToPeer(peer, { type: 'disconnected', payload: { reason: JOB_ENDED_REASON } })
    this.log(`replay-ended id=${session.id} key=${session.sessionKey ?? '-'}`)
  }

  private unbindPeersOf(id: string): void {
    for (const [peer, sid] of this.peerSession) {
      if (sid === id) {
        this.peerSession.delete(peer)
      }
    }
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

  /**
   * Client `disconnect` message. Named for the message rather than for one of its two outcomes,
   * because it no longer always kills.
   *
   * **Interactive: kill**, regardless of sessionKey. The person closed their terminal and meant it.
   *
   * **Job: detach, never kill.** `disconnect` comes from whoever is watching, and a watcher going
   * away is not a decision about the deploy. Without this branch the door `prepareConnect` closes
   * stays open right behind it — the watcher that could no longer evict a job could still end it by
   * saying goodbye. See the class note above `prepareConnect`.
   */
  handleDisconnect(peer: SocketPeer): void {
    const id = this.peerSession.get(peer)
    this.peerSession.delete(peer)
    if (!id) {
      return
    }
    const session = this.sessions.get(id)
    if (!session || session.attachedPeer !== peer) {
      return
    }
    if (session.kind === 'job') {
      session.attachedPeer = null
      session.detachedAt = this.now()
      this.log(`detach id=${id} key=${session.sessionKey ?? '-'} reason=disconnect`)
      return
    }
    this.kill(id, 'explicit')
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
    this.unbindPeersOf(id)
    const suffix = context ? ` (${context})` : ''
    this.log(`kill id=${id} key=${session.sessionKey ?? '-'} reason=${reason}${suffix}`)
  }

  private isUnwatchedTooLong(session: ManagedSession, now: number): boolean {
    return (
      session.kind === 'job' &&
      session.endedAt === null &&
      session.stopWhenUnwatchedMs !== undefined &&
      session.detachedAt !== null &&
      now - session.detachedAt > session.stopWhenUnwatchedMs
    )
  }

  private sweep(): void {
    const now = this.now()
    let killed = 0
    for (const session of [...this.sessions.values()]) {
      // An ended job's process is dead by definition, and keeping it is the point; the TTL
      // below is what reclaims it.
      if (!session.handle.isAlive() && session.endedAt === null) {
        this.kill(session.id, 'exit', undefined, 'sweep-dead-process')
        killed++
        continue
      }
      if (this.isUnwatchedTooLong(session, now)) {
        // Stopping the command, not dropping the session: the job ends the ordinary way and its
        // output stays readable like any other ended job's.
        this.log(`stop-unwatched id=${session.id} key=${session.sessionKey ?? '-'}`)
        session.handle.kill()
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

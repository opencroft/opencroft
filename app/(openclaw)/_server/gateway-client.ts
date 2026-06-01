import WebSocket from 'ws';

import {
  buildDeviceAuthPayloadV3,
  clearDeviceToken,
  DeviceIdentity,
  loadDeviceToken,
  loadOrCreateIdentity,
  publicKeyBase64Url,
  saveDeviceToken,
  signPayload,
} from '@/app/(openclaw)/_server/device-identity';
import { getSetting } from '@/app/(settings)/server/actions';

interface Pending {
  resolve: (payload: unknown) => void;
  reject: (error: Error) => void;
}

interface GatewayConfig {
  url: string;
  token: string;
}

interface GatewayConfigSettings {
  gatewayUrl?: string | null;
  gatewayToken?: string | null;
}

interface ErrorDetails {
  code?: string;
  requestId?: string;
  reason?: string;
}

interface Frame {
  type: 'req' | 'res' | 'event';
  id?: string;
  method?: string;
  params?: unknown;
  event?: string;
  payload?: unknown;
  ok?: boolean;
  error?: { code?: string; message?: string; details?: ErrorDetails };
}

interface HelloOkAuth {
  role?: string;
  scopes?: string[];
  deviceToken?: string;
}

interface HelloOkPayload {
  auth?: HelloOkAuth;
}

export class PairingPendingError extends Error {
  constructor(public requestId: string | null, public deviceId: string) {
    super(requestId ? `pairing pending: ${requestId}` : 'pairing pending');
    this.name = 'PairingPendingError';
  }
}

export class GatewayNotConfiguredError extends Error {
  constructor() {
    super('OpenClaw gateway URL and token must be configured (Settings → AI or env vars)');
    this.name = 'GatewayNotConfiguredError';
  }
}

const CLIENT_ID = 'gateway-client';
const CLIENT_MODE = 'backend';
const ROLE = 'operator';
const REQUESTED_SCOPES = ['operator.read', 'operator.write', 'operator.admin'];

type EventHandler = (payload: unknown) => void;

class GatewayClient {
  private socket: WebSocket | null = null;
  private ready: Promise<void> | null = null;
  private config: GatewayConfig | null = null;
  private pending = new Map<string, Pending>();
  private handlers = new Map<string, Set<EventHandler>>();
  private nextId = 1;
  private identity: DeviceIdentity | null = null;

  constructor(private loadConfig: () => Promise<GatewayConfig>) {}

  async call<T = unknown>(method: string, params: object = {}): Promise<T> {
    try {
      return await this.callOnce<T>(method, params);
    } catch (error) {
      if (isTokenMismatch(error) && loadDeviceToken()) {
        this.resetForRetry();
        return this.callOnce<T>(method, params);
      }
      throw error;
    }
  }

  private async callOnce<T = unknown>(method: string, params: object = {}): Promise<T> {
    await this.ensureReady();
    return new Promise<T>((resolve, reject) => {
      const id = String(this.nextId++);
      this.pending.set(id, { resolve: resolve as (v: unknown) => void, reject });
      this.socket!.send(JSON.stringify({ type: 'req', id, method, params }));
    });
  }

  on(event: string, handler: EventHandler): () => void {
    let set = this.handlers.get(event);
    if (!set) {
      set = new Set();
      this.handlers.set(event, set);
    }
    set.add(handler);
    return () => {
      set.delete(handler);
    };
  }

  getIdentity(): DeviceIdentity {
    if (!this.identity) {
      this.identity = loadOrCreateIdentity();
    }
    return this.identity;
  }

  dispose(): void {
    this.socket?.close();
    this.socket = null;
    this.ready = null;
    this.config = null;
    for (const entry of this.pending.values()) {
      entry.reject(new Error('gateway disposed'));
    }
    this.pending.clear();
  }

  private async ensureReady(): Promise<void> {
    if (!this.config) {
      this.config = await this.loadConfig();
    }
    if (!this.ready) {
      this.ready = this.connect();
    }
    try {
      await this.ready;
    } catch (error) {
      if (isTokenMismatch(error) && loadDeviceToken()) {
        this.resetForRetry();
        this.ready = this.connect();
        await this.ready;
        return;
      }
      throw error;
    }
  }

  private resetForRetry(): void {
    clearDeviceToken();
    for (const entry of this.pending.values()) {
      entry.reject(new Error('gateway reset for retry'));
    }
    this.pending.clear();
    this.socket?.close();
    this.socket = null;
    this.ready = null;
  }

  private connect(): Promise<void> {
    this.identity = this.getIdentity();
    return new Promise((resolve, reject) => {
      const socket = new WebSocket(this.config!.url);
      this.socket = socket;

      socket.on('message', (raw) => {
        if (this.socket !== socket) {
          return;
        }
        const frame = JSON.parse(String(raw)) as Frame;
        this.handleFrame(frame, resolve, reject);
      });

      socket.on('close', () => {
        if (this.socket !== socket) {
          return;
        }
        this.socket = null;
        this.ready = null;
        for (const entry of this.pending.values()) {
          entry.reject(new Error('gateway connection closed'));
        }
        this.pending.clear();
      });

      socket.on('error', (error) => {
        if (this.socket !== socket) {
          return;
        }
        this.ready = null;
        reject(error);
      });
    });
  }

  private handleFrame(frame: Frame, resolveReady: () => void, rejectReady: (e: Error) => void) {
    if (frame.type === 'event' && frame.event === 'connect.challenge') {
      const payload = frame.payload as { nonce?: string } | undefined;
      this.sendConnect(payload?.nonce ?? '', resolveReady, rejectReady);
      return;
    }
    if (frame.type === 'event' && frame.event) {
      const set = this.handlers.get(frame.event);
      if (set) {
        for (const handler of set) {
          handler(frame.payload);
        }
      }
      return;
    }
    if (frame.type !== 'res' || !frame.id) {
      return;
    }
    const entry = this.pending.get(frame.id);
    if (!entry) {
      return;
    }
    this.pending.delete(frame.id);
    if (frame.ok) {
      entry.resolve(frame.payload);
      return;
    }
    entry.reject(this.buildError(frame));
  }

  private buildError(frame: Frame): Error {
    const details = frame.error?.details;
    const isPairing = frame.error?.code === 'NOT_PAIRED' || details?.code === 'PAIRING_REQUIRED';
    if (isPairing) {
      return new PairingPendingError(details?.requestId ?? null, this.identity?.deviceId ?? '');
    }
    return new Error(frame.error?.message ?? 'rpc failed');
  }

  private sendConnect(nonce: string, resolveReady: () => void, rejectReady: (e: Error) => void) {
    if (!this.identity) {
      rejectReady(new Error('identity not initialized'));
      return;
    }
    const stored = loadDeviceToken();
    const auth = stored?.deviceToken
      ? { deviceToken: stored.deviceToken }
      : { token: this.config!.token };
    const signatureToken = stored?.deviceToken ?? this.config!.token;
    const signedAtMs = Date.now();
    const payload = buildDeviceAuthPayloadV3({
      deviceId: this.identity.deviceId,
      clientId: CLIENT_ID,
      clientMode: CLIENT_MODE,
      role: ROLE,
      scopes: REQUESTED_SCOPES,
      signedAtMs,
      token: signatureToken,
      nonce,
      platform: 'node',
    });
    const signature = signPayload(this.identity.privateKeyPem, payload);

    const id = String(this.nextId++);
    this.pending.set(id, {
      resolve: (helloOk) => this.onHelloOk(helloOk as HelloOkPayload, resolveReady),
      reject: (error) => {
        this.ready = null;
        this.socket?.close();
        this.socket = null;
        rejectReady(error);
      },
    });

    this.socket!.send(JSON.stringify({
      type: 'req',
      id,
      method: 'connect',
      params: {
        minProtocol: 4,
        maxProtocol: 4,
        client: {
          id: CLIENT_ID,
          version: '0.1.0',
          platform: 'node',
          mode: CLIENT_MODE,
        },
        role: ROLE,
        scopes: REQUESTED_SCOPES,
        caps: [],
        commands: [],
        permissions: {},
        locale: 'en-US',
        userAgent: 'opencroft-gateway-client/0.1.0',
        auth,
        device: {
          id: this.identity.deviceId,
          publicKey: publicKeyBase64Url(this.identity.publicKeyPem),
          signature,
          signedAt: signedAtMs,
          nonce,
        },
      },
    }));
  }

  private onHelloOk(helloOk: HelloOkPayload, resolveReady: () => void) {
    const auth = helloOk?.auth;
    if (auth?.deviceToken) {
      saveDeviceToken({
        deviceToken: auth.deviceToken,
        role: auth.role ?? ROLE,
        scopes: auth.scopes ?? REQUESTED_SCOPES,
        savedAtMs: Date.now(),
      });
    }
    resolveReady();
  }
}

function isTokenMismatch(error: unknown): boolean {
  if (!(error instanceof Error)) {
    return false;
  }
  return /device token mismatch|rotate.*token|reissue.*device token/i.test(error.message);
}

declare global {
  var openclawGateway: GatewayClient | undefined;
}

async function loadGatewayConfig(): Promise<GatewayConfig> {
  const row = await getSetting({ data: 'ai-settings' });
  const url = row?.data?.gatewayUrl?.trim() || process.env.OPENCLAW_GATEWAY_URL;
  const token = row?.data?.gatewayToken?.trim() || process.env.OPENCLAW_GATEWAY_TOKEN;
  if (!url || !token) {
    throw new GatewayNotConfiguredError();
  }
  return { url, token };
}

function isStale(client: GatewayClient | undefined): boolean {
  if (!client) {
    return false;
  }
  return typeof (client as { dispose?: unknown }).dispose !== 'function';
}

export function gateway(): GatewayClient {
  if (isStale(globalThis.openclawGateway)) {
    globalThis.openclawGateway = undefined;
  }
  if (!globalThis.openclawGateway) {
    globalThis.openclawGateway = new GatewayClient(loadGatewayConfig);
  }
  return globalThis.openclawGateway;
}

export function resetGateway(): void {
  const existing = globalThis.openclawGateway;
  if (existing && typeof existing.dispose === 'function') {
    existing.dispose();
  }
  globalThis.openclawGateway = undefined;
}

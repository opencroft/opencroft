const url = process.env.OPENCLAW_GATEWAY_URL ?? 'ws://127.0.0.1:18799/';
const token = process.env.OPENCLAW_GATEWAY_TOKEN;

if (!token) {
  console.error('OPENCLAW_GATEWAY_TOKEN not set');
  process.exit(1);
}

const ws = new WebSocket(url);
const pending = new Map();
let nextId = 1;

const call = (method, params = {}) => {
  return new Promise((resolve, reject) => {
    const id = String(nextId++);
    pending.set(id, { resolve, reject });
    ws.send(JSON.stringify({ type: 'req', id, method, params }));
  });
};

const connect = () => call('connect', {
  minProtocol: 1,
  maxProtocol: 3,
  client: {
    id: 'gateway-client',
    version: '0.1.0',
    platform: 'node',
    mode: 'backend',
  },
  role: 'operator',
  scopes: ['operator.read'],
  auth: { token },
});

const enumerate = async () => {
  const agents = await call('agents.list', {});
  console.log('\n=== agents.list ===');
  console.log(JSON.stringify(agents, null, 2));

  const list = Array.isArray(agents?.agents) ? agents.agents : agents?.items ?? [];

  for (const agent of list) {
    const agentId = agent.agentId ?? agent.id ?? agent.name;
    if (!agentId) {
      continue;
    }
    const sessions = await call('sessions.list', {
      agentId,
      limit: 1000,
      includeUnknown: true,
      includeDerivedTitles: true,
      includeLastMessage: true,
    });
    console.log(`\n=== sessions.list (agentId=${agentId}) ===`);
    console.log(JSON.stringify(sessions, null, 2));
  }
};

ws.onopen = () => {
  console.log('[open]', url);
};

ws.onclose = (e) => {
  console.log('[close]', { code: e.code, reason: String(e.reason) });
  process.exit(0);
};

ws.onerror = (e) => {
  console.log('[error]', String(e.message ?? e));
};

ws.onmessage = async (ev) => {
  const m = JSON.parse(ev.data);

  if (m.type === 'event' && m.event === 'connect.challenge') {
    const hello = await connect();
    console.log('\n=== hello-ok ===');
    console.log('protocol:', hello.protocol, '| server:', hello.server?.version);
    await enumerate();
    ws.close(1000, 'done');
    return;
  }

  if (m.type === 'res') {
    const entry = pending.get(m.id);
    if (!entry) {
      return;
    }
    pending.delete(m.id);
    if (m.ok) {
      entry.resolve(m.payload);
    } else {
      entry.reject(new Error(m.error?.message ?? 'rpc failed'));
    }
  }
};

setTimeout(() => {
  console.log('[timeout]');
  try {
    ws.close();
  } catch {}
  process.exit(2);
}, 15000);

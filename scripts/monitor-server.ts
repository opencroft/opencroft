import { createServer } from 'node:http';

const port = Number(process.env.MONITOR_PORT ?? 7777);

function readBody(req: Parameters<Parameters<typeof createServer>[0]>[0]): Promise<string> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    req.on('data', (c) => chunks.push(Buffer.from(c)));
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    req.on('error', reject);
  });
}

const server = createServer(async (req, res) => {
  if (req.method !== 'POST') {
    res.writeHead(405, { 'content-type': 'text/plain' });
    res.end('POST only\n');
    return;
  }

  const body = await readBody(req);
  const stamp = new Date().toISOString();
  process.stdout.write(`[${stamp}] ${body}\n`);

  res.writeHead(200, { 'content-type': 'text/plain' });
  res.end('ok\n');
});

server.listen(port, () => {
  process.stdout.write(`monitor-server listening on http://127.0.0.1:${port}\n`);
  process.stdout.write(`send: curl -X POST http://127.0.0.1:${port} -d 'hello'\n`);
});

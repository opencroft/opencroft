import { spawn } from 'node:child_process';
import { cpSync, existsSync } from 'node:fs';
import { resolve } from 'node:path';

const standalone = resolve('.next/standalone');

if (!existsSync(`${standalone}/server.js`)) {
  console.error('Run `npm run build` first.');
  process.exit(1);
}

cpSync('.next/static', `${standalone}/.next/static`, { recursive: true });
cpSync('public', `${standalone}/public`, { recursive: true });

const env = {
  ...process.env,
  PORT: process.env.PORT ?? '9999',
  HOSTNAME: process.env.HOSTNAME ?? '0.0.0.0',
};

const proc = spawn('node', ['server.js'], { cwd: standalone, stdio: 'inherit', env });
proc.on('exit', (code) => process.exit(code ?? 0));

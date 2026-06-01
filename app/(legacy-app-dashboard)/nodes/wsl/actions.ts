import { execFile } from 'node:child_process';

import { createServerFn } from '@tanstack/react-start';

export interface WslStats {
  os: string;
  cpu: string;
  memory: string;
  storage: string;
}

function wslExec(distro: string, cmd: string): Promise<string> {
  return new Promise((resolve, reject) => {
    execFile('wsl', ['-d', distro, '--exec', 'bash', '-c', cmd], { windowsHide: true }, (err, stdout) => {
      if (err) {
        reject(err);
        return;
      }
      resolve(stdout);
    });
  });
}

export const getWslStats = createServerFn({ method: 'POST' }).inputValidator((distro: string) => distro).handler(async ({ data: distro }): Promise<WslStats> => {
  const script = [
    'echo "OS=$(. /etc/os-release 2>/dev/null && echo "$PRETTY_NAME" || uname -s)"',
    'echo "CPU=$(grep -c ^processor /proc/cpuinfo 2>/dev/null || echo unknown)x $(grep "model name" /proc/cpuinfo 2>/dev/null | head -1 | cut -d: -f2 | xargs || uname -m)"',
    'echo "MEMORY=$(free -h 2>/dev/null | awk \'/^Mem:/{print $3"/"$2}\' || echo unknown)"',
    'echo "STORAGE=$(df -h / 2>/dev/null | awk \'NR==2{print $3"/"$2}\' || echo unknown)"',
  ].join(' && ');

  const output = await wslExec(distro, script);
  const lines: Record<string, string> = {};
  for (const line of output.trim().split('\n')) {
    const [key, ...rest] = line.split('=');
    lines[key] = rest.join('=');
  }

  return {
    os: lines['OS'] || 'unknown',
    cpu: lines['CPU'] || 'unknown',
    memory: lines['MEMORY'] || 'unknown',
    storage: lines['STORAGE'] || 'unknown',
  };
});

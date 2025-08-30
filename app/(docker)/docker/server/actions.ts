'use server';

import { spawn } from 'child_process';
import { networkInterfaces } from 'os';

import { resolveServer } from '@/app/(docker)/docker/server/context-actions';

async function contextArgs(server?: string): Promise<string[]> {
  const context = server ? await resolveServer(server) : undefined;
  if (context && context !== 'default') {
    return ['--context', context];
  }
  return [];
}

function getLocalIPAddress(): string {
  const interfaces = networkInterfaces();

  for (const interfaceName in interfaces) {
    const networkInterface = interfaces[interfaceName];
    if (networkInterface) {
      for (const alias of networkInterface) {
        if (alias.family === 'IPv4' && !alias.internal && alias.address.startsWith('192.168.')) {
          return alias.address;
        }
      }
    }
  }

  // Fallback to any non-internal IPv4
  for (const interfaceName in interfaces) {
    const networkInterface = interfaces[interfaceName];
    if (networkInterface) {
      for (const alias of networkInterface) {
        if (alias.family === 'IPv4' && !alias.internal) {
          return alias.address;
        }
      }
    }
  }

  return 'localhost';
}

function parsePortsToUrls(ports: string): string[] {
  if (!ports) {
    return [];
  }

  const localIP = getLocalIPAddress();
  const portMappings = ports.split(', ');
  const urls: string[] = [];

  portMappings.forEach(mapping => {
    // Extract port from patterns like "0.0.0.0:11434->11434/tcp"
    const match = mapping.match(/0\.0\.0\.0:(\d+)->\d+\/(tcp|udp)/);
    if (match) {
      const port = match[1];
      const protocol = match[2] === 'tcp' ? 'http' : 'http'; // Default to http
      urls.push(`${protocol}://${localIP}:${port}`);
    }
  });

  return urls;
}

export interface VolumeMount {
  source: string;
  destination: string;
}

export interface DockerContainer {
  id: string;
  image: string;
  command: string;
  createdAt: string;
  runningFor: string;
  ports: string;
  urls: string[];
  status: string;
  size: string;
  names: string;
  labels: string;
  mounts: string;
  networks: string;
  volumeMounts?: VolumeMount[];
}

interface KeyValuePair {
  key: string;
  value: string;
}

export interface CreateDockerContainerData {
  name: string;
  image: string;
  portMappings: KeyValuePair[];
  temporary: boolean;
  gpus: boolean;
  environmentVariables: KeyValuePair[];
  volumeMappings: KeyValuePair[];
  restart?: string;
  command?: string;
  healthcheck?: {
    test?: string;
    interval?: string;
    timeout?: string;
    retries?: number;
    startPeriod?: string;
  };
  build?: {
    context?: string;
    dockerfile?: string;
    args?: KeyValuePair[];
  };
  extraHosts?: string[];
}

export async function getDockerContainers(server?: string): Promise<DockerContainer[]> {
  const ctxArgs = await contextArgs(server);
  return new Promise((resolve, reject) => {
    const child = spawn('wsl', ['--exec', 'docker', ...ctxArgs, 'ps', '-a', '--format=json'], { windowsHide: true });
    let stdout = '';
    let stderr = '';

    child.stdout.on('data', (data) => {
      stdout += data.toString();
    });

    child.stderr.on('data', (data) => {
      stderr += data.toString();
    });

    child.on('close', (code) => {
      if (code !== 0) {
        reject(new Error(`Docker containers command failed with code ${code}: ${stderr}`));
        return;
      }

      try {
        const lines = stdout.split('\n').filter(line => line.trim());
        const containers: DockerContainer[] = lines.map((line) => {
          const jsonData = JSON.parse(line);
          const ports = jsonData.Ports || '';
          return {
            id: jsonData.ID || 'unknown',
            image: jsonData.Image || 'unknown',
            command: jsonData.Command || '',
            createdAt: jsonData.CreatedAt || '',
            runningFor: jsonData.RunningFor || '',
            ports,
            urls: parsePortsToUrls(ports),
            status: jsonData.Status || '',
            size: jsonData.Size || 'N/A',
            names: jsonData.Names || 'unknown',
            labels: jsonData.Labels || '',
            mounts: jsonData.Mounts || '',
            networks: jsonData.Networks || '',
          };
        });

        resolve(containers);
      } catch (error) {
        reject(error);
      }
    });

    child.on('error', (error) => {
      reject(error);
    });
  });
}

export async function createContainer(containerData: CreateDockerContainerData): Promise<void> {
  return new Promise((resolve, reject) => {
    const args = ['--exec', 'docker', 'run'];

    if (containerData.temporary) {
      args.push('--rm');
    }

    if (containerData.name) {
      args.push('--name', containerData.name);
    }

    if (containerData.portMappings) {
      containerData.portMappings.forEach(({ key: hostPort, value: containerPort }) => {
        if (hostPort && containerPort) {
          args.push('-p', `${hostPort}:${containerPort}`);
        }
      });
    }

    if (containerData.gpus) {
      args.push('--gpus=all');
    }

    if (containerData.restart) {
      args.push('--restart', containerData.restart);
    }

    if (containerData.environmentVariables) {
      containerData.environmentVariables.forEach(({ key, value }) => {
        if (key && value) {
          args.push('-e', `${key}=${value}`);
        }
      });
    }

    if (containerData.volumeMappings) {
      containerData.volumeMappings.forEach(({ key: hostPath, value: containerPath }) => {
        if (hostPath && containerPath) {
          args.push('-v', `${hostPath}:${containerPath}`);
        }
      });
    }

    args.push('-d', containerData.image);

    const child = spawn('wsl', args, { windowsHide: true });
    let stderr = '';

    child.stderr.on('data', (data) => {
      stderr += data.toString();
    });

    child.on('close', (code) => {
      if (code !== 0) {
        reject(new Error(`Failed to create container: ${stderr}`));
        return;
      }
      console.log(`Created Docker container: ${containerData.name}`);
      resolve();
    });

    child.on('error', (error) => {
      reject(error);
    });
  });
}

export async function startContainer(containerId: string): Promise<void> {
  return new Promise((resolve, reject) => {
    const child = spawn('wsl', ['--exec', 'docker', 'start', containerId], { windowsHide: true });
    let stderr = '';

    child.stderr.on('data', (data) => {
      stderr += data.toString();
    });

    child.on('close', (code) => {
      if (code !== 0) {
        reject(new Error(`Failed to start container ${containerId}: ${stderr}`));
        return;
      }
      console.log(`Started Docker container: ${containerId}`);
      resolve();
    });

    child.on('error', (error) => {
      reject(error);
    });
  });
}

export async function stopContainer(containerId: string): Promise<void> {
  return new Promise((resolve, reject) => {
    const child = spawn('wsl', ['--exec', 'docker', 'stop', containerId], { windowsHide: true });
    let stderr = '';

    child.stderr.on('data', (data) => {
      stderr += data.toString();
    });

    child.on('close', (code) => {
      if (code !== 0) {
        reject(new Error(`Failed to stop container ${containerId}: ${stderr}`));
        return;
      }
      console.log(`Stopped Docker container: ${containerId}`);
      resolve();
    });

    child.on('error', (error) => {
      reject(error);
    });
  });
}

export async function rebootContainer(containerId: string): Promise<void> {
  return new Promise((resolve, reject) => {
    const child = spawn('wsl', ['--exec', 'docker', 'restart', containerId], { windowsHide: true });
    let stderr = '';

    child.stderr.on('data', (data) => {
      stderr += data.toString();
    });

    child.on('close', (code) => {
      if (code !== 0) {
        reject(new Error(`Failed to reboot container ${containerId}: ${stderr}`));
        return;
      }
      console.log(`Rebooted Docker container: ${containerId}`);
      resolve();
    });

    child.on('error', (error) => {
      reject(error);
    });
  });
}

export async function removeContainer(containerId: string): Promise<void> {
  return new Promise((resolve, reject) => {
    const child = spawn('wsl', ['--exec', 'docker', 'rm', containerId], { windowsHide: true });
    let stderr = '';

    child.stderr.on('data', (data) => {
      stderr += data.toString();
    });

    child.on('close', (code) => {
      if (code !== 0) {
        reject(new Error(`Failed to remove container ${containerId}: ${stderr}`));
        return;
      }
      console.log(`Removed Docker container: ${containerId}`);
      resolve();
    });

    child.on('error', (error) => {
      reject(error);
    });
  });
}

export async function getContainerMounts(containerId: string): Promise<VolumeMount[]> {
  return new Promise((resolve, reject) => {
    const child = spawn('wsl', ['--exec', 'docker', 'inspect', containerId, '--format={{json .Mounts}}'], { windowsHide: true });
    let stdout = '';
    let stderr = '';

    child.stdout.on('data', (data) => {
      stdout += data.toString();
    });

    child.stderr.on('data', (data) => {
      stderr += data.toString();
    });

    child.on('close', (code) => {
      if (code !== 0) {
        reject(new Error(`Failed to inspect container ${containerId}: ${stderr}`));
        return;
      }

      try {
        const mounts = JSON.parse(stdout);
        const volumeMounts: VolumeMount[] = mounts.map((mount: { Source: string; Destination: string }) => ({
          source: mount.Source,
          destination: mount.Destination,
        }));
        resolve(volumeMounts);
      } catch (error) {
        reject(error);
      }
    });

    child.on('error', (error) => {
      reject(error);
    });
  });
}

export async function openTerminalInContainer(containerId: string, workingDir?: string): Promise<void> {
  return new Promise(() => {
    const args = ['--exec', 'docker', 'exec', '-it'];
    if (workingDir) {
      args.push('-w', workingDir);
    }
    args.push(containerId, 'sh');

    spawn('wsl', args, {
      detached: true,
      windowsHide: false
    });
  });
}

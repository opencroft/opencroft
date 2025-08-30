export interface SshFeature {
  type: 'ssh';
  port?: number;
  username?: string;
  password?: string;
  keyPath?: string;
}

export interface DockerFeature {
  type: 'docker';
  installed?: boolean;
}

export type ServerFeature = SshFeature | DockerFeature;

export enum ServerOS {
  Linux = 'linux',
  Windows = 'windows',
  Mac = 'mac',
  Other = 'other',
}

export interface Server {
  name: string;
  address: string;
  os?: ServerOS;
  features: ServerFeature[];
}

export function slug(name: string): string {
  return name
    .toLowerCase()
    .trim()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-|-$/g, '');
}

export function getSshFeature(server: Server): SshFeature | undefined {
  return server.features.find(f => f.type === 'ssh') as SshFeature | undefined;
}

export function getDockerFeature(server: Server): DockerFeature | undefined {
  return server.features.find(f => f.type === 'docker') as DockerFeature | undefined;
}

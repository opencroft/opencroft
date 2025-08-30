'use client';

import { FileManagerProvider } from '@/app/(filemanager)/files/filemanager-provider';
import { DockerComposeProvider } from '@/components/providers/docker-compose-provider';
import { DockerProvider } from '@/components/providers/docker-provider';

export function PluginProvider({ children }: { children: React.ReactNode }) {
  return (
    <DockerProvider>
      <DockerComposeProvider>
        <FileManagerProvider>
          {children}
        </FileManagerProvider>
      </DockerComposeProvider>
    </DockerProvider>
  );
}

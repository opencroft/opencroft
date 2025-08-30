'use client';

import { Apple, Monitor, Server as ServerIcon, TerminalSquare } from 'lucide-react';

import { Server, ServerOS } from '@/app/(server)/server/types';
import { Flex } from '@/components/ui/layout/flex';
import { StatusIndicator } from '@/components/ui/utils/status-indicator';

const osIcons: Record<string, React.ElementType> = {
  [ServerOS.Linux]: TerminalSquare,
  [ServerOS.Windows]: Monitor,
  [ServerOS.Mac]: Apple,
  [ServerOS.Other]: ServerIcon,
};

export function ServerItem({ server, active, onClick }: {
  server: Server;
  active?: boolean;
  onClick: () => void;
}) {
  const OsIcon = server.os ? osIcons[server.os] : ServerIcon;

  return (
    <Flex
      row
      align="center"
      className={`gap-2 px-3 py-2 rounded-md cursor-pointer text-sm ${
        active ? 'bg-accent font-medium' : 'hover:bg-accent/50'
      }`}
      onClick={onClick}
    >
      <div className="relative shrink-0">
        <OsIcon className="h-4 w-4 text-muted-foreground" />
        <StatusIndicator
          className="absolute -bottom-0.5 -right-0.5"
          variant={server.features.length > 0 ? 'success' : 'muted'}
        />
      </div>
      <Flex expanded className="min-w-0 gap-0">
        <span className="truncate font-medium">{server.name}</span>
        <span className="text-xs text-muted-foreground truncate">{server.address}</span>
      </Flex>
    </Flex>
  );
}

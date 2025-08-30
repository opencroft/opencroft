import Image from 'next/image';

import { Flex } from '@/components/ui/layout/flex';
import { StatusIndicator, StatusVariant } from '@/components/ui/utils/status-indicator';

interface ServiceMenuItemProps extends React.HTMLAttributes<HTMLDivElement> {
  iconSrc: string;
  status?: StatusVariant;
  children: React.ReactNode;
}

export function ServiceMenuItem({ iconSrc, status, children, ...props }: ServiceMenuItemProps) {
  return (
    <Flex
      row
      withSpacing
      align='center'
      className='bg-secondary rounded-lg overflow-hidden cursor-pointer hover:shadow-lg transition-shadow group text-sm font-medium text-foreground'
      {...props}
    >
      <div className='relative min-w-12 min-h-12 bg-background/30 rounded-lg'>
        <Image alt='' fill src={iconSrc} />
        <StatusIndicator className='absolute bottom-1 right-1' variant={status} />
      </div>
      <Flex>
        {children}
      </Flex>
    </Flex>
  );
}

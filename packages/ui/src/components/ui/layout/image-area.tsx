import { cn } from '@/lib/utils';

import { FixedArea } from '@/components/ui/layout/fixed-area';

export interface ImageAreaProps {
  children: React.ReactNode;
  src: string;
  className?: string;
}

export function ImageArea({ children, src, className }: ImageAreaProps) {
  return (
    <>
      <div className="absolute inset-0 overflow-hidden">
        <div
          className="absolute inset-0 scale-110 blur-3xl opacity-30"
          style={{
            backgroundImage: `url(${src})`,
            backgroundSize: 'cover',
            backgroundPosition: 'center',
          }}
        />
      </div>
      <FixedArea className={cn('p-2', className)}>
        {children}
      </FixedArea>
    </>
  );
}

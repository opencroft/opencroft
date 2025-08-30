'use client';

import { AlertTriangle, Copy, type LucideIcon } from 'lucide-react';
import { createContext, useContext, type ReactNode } from 'react';
import { toast } from 'sonner';

import { NodeCard, NodeCardContent, NodeCardHeader } from '@/app/(dashboard)/_canvas/node-card';
import { Button } from '@/components/ui/button';
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from '@/components/ui/tooltip';
import { type StatusVariant as IndicatorVariant } from '@/components/ui/utils/status-indicator';

type StatusVariant = 'success' | 'warning' | 'error' | 'info' | 'neutral';

const STATUS_MAP: Record<StatusVariant, IndicatorVariant | undefined> = {
  success: 'success',
  warning: 'warning',
  error: 'destructive',
  info: 'primary',
  neutral: undefined,
};

const NodeAccentContext = createContext<string>('var(--muted-foreground)');

export function NodeAccentProvider({ accent, children }: { accent: string; children: ReactNode }) {
  return <NodeAccentContext.Provider value={accent}>{children}</NodeAccentContext.Provider>;
}

export function useNodeAccent(): string {
  return useContext(NodeAccentContext);
}

interface NodeFrameProps {
  icon: LucideIcon;
  title: string;
  subtitle?: string;
  status?: StatusVariant;
  extra?: ReactNode;
  selected: boolean;
  loading?: boolean;
  errors?: string[];
  input?: ReactNode;
  output?: ReactNode;
  children?: ReactNode;
}

function copyToClipboard(message: string) {
  navigator.clipboard.writeText(message);
  toast.success('Copied error to clipboard');
}

function NodeErrorTooltip({ errors, children }: { errors: string[]; children: ReactNode }) {
  return (
    <TooltipProvider delayDuration={200}>
      <Tooltip>
        <TooltipTrigger asChild>
          <div>{children}</div>
        </TooltipTrigger>
        <TooltipContent
          side='top'
          className='nodrag nopan max-w-sm bg-destructive text-destructive-foreground p-2 pointer-events-auto select-text'
        >
          <div className='flex flex-col gap-1'>
            {errors.map((msg, i) => (
              <div key={i} className='flex items-start gap-2'>
                <span className='text-xs whitespace-pre-wrap break-words flex-1 font-mono'>{msg}</span>
                <Button
                  variant='ghost'
                  size='icon'
                  className='h-5 w-5 shrink-0 text-destructive-foreground hover:bg-destructive-foreground/20 hover:text-destructive-foreground'
                  onClick={() => copyToClipboard(msg)}
                >
                  <Copy className='h-3 w-3' />
                </Button>
              </div>
            ))}
          </div>
        </TooltipContent>
      </Tooltip>
    </TooltipProvider>
  );
}

export function NodeFrame({ icon, title, subtitle, status, extra, selected, loading, errors, input, output, children }: NodeFrameProps) {
  const accent = useContext(NodeAccentContext);
  const hasErrors = !!errors && errors.length > 0;
  const displayIcon = hasErrors ? AlertTriangle : icon;
  const iconClassName = hasErrors ? 'text-destructive' : undefined;
  const titleClassName = hasErrors ? 'text-destructive' : undefined;

  const card = (
    <NodeCard selected={selected} loading={loading} accent={accent} error={hasErrors}>
      <NodeCardHeader
        icon={displayIcon}
        iconClassName={iconClassName}
        title={title}
        titleClassName={titleClassName}
        subtitle={subtitle}
        status={status ? STATUS_MAP[status] : undefined}
        extra={extra}
        input={input}
        output={output}
      />
      {children && (
        <NodeCardContent>
          {children}
        </NodeCardContent>
      )}
    </NodeCard>
  );

  if (!hasErrors) {
    return card;
  }
  return (
    <NodeErrorTooltip errors={errors}>
      {card}
    </NodeErrorTooltip>
  );
}

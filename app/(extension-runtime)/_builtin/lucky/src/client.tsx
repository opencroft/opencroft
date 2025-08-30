import { React, defineExtension, icons, useOverlayBar, useOverlayMenu } from '@ext/host';
import type { CommandModeProps } from '@ext/host';
import { CommandBarMenuItem, Input } from '@ext/ui';

function pickRandom<T>(items: T[]): T | null {
  if (items.length === 0) {
    return null;
  }
  return items[Math.floor(Math.random() * items.length)];
}

function LuckyMode({ nodes, focusTick, onFocusNode, onClose }: CommandModeProps) {
  const [tick, setTick] = React.useState(0);
  const inputRef = React.useRef<HTMLInputElement>(null);

  React.useEffect(() => {
    inputRef.current?.focus();
  }, [focusTick]);

  const pick = React.useMemo(() => pickRandom(nodes), [nodes, tick]);

  const reroll = React.useCallback(() => {
    setTick((t) => t + 1);
  }, []);

  const accept = React.useCallback(() => {
    if (!pick) {
      return;
    }
    onFocusNode(pick.id);
    inputRef.current?.blur();
    onClose();
  }, [pick, onFocusNode, onClose]);

  const onKeyDown = (event: React.KeyboardEvent<HTMLInputElement>) => {
    if (event.key === 'Enter') {
      event.preventDefault();
      accept();
      return;
    }
    if (event.key === ' ' || event.key === 'ArrowDown' || event.key === 'ArrowUp') {
      event.preventDefault();
      reroll();
    }
  };

  const Dice = icons.Dices;
  const PickIcon = pick?.icon ?? icons.Box;
  const display = pick ? pick.label : 'No nodes on canvas';

  const menuNode = React.useMemo(() => {
    if (!pick) {
      return null;
    }
    return (
      <CommandBarMenuItem active onSelect={accept}>
        <div className='flex items-center gap-2 text-sm'>
          <PickIcon className='h-4 w-4 shrink-0' style={{ color: pick.accent }} />
          <span className='truncate'>{pick.label}</span>
          <span className='ml-auto text-[10px] font-mono text-muted-foreground truncate'>
            {pick.subtitle}
          </span>
        </div>
        <div className='pl-6 text-[11px] text-muted-foreground'>
          Enter to focus · Space to reroll · Esc to cancel
        </div>
      </CommandBarMenuItem>
    );
  }, [pick, PickIcon, accept]);

  const barNode = React.useMemo(() => (
    <>
      <Dice className='h-4 w-4 ml-1 mt-1.5 shrink-0 text-primary' />
      <Input
        ref={inputRef}
        readOnly
        value={display}
        onKeyDown={onKeyDown}
        placeholder='Lucky pick'
        className='border-0 shadow-none focus-visible:ring-0 focus-visible:border-0 bg-transparent h-8'
      />
    </>
    // eslint-disable-next-line react-hooks/exhaustive-deps
  ), [display]);

  useOverlayBar(barNode);
  useOverlayMenu(menuNode);

  return null;
}

export default defineExtension({
  manifest: {
    id: 'builtin/lucky',
    name: 'Lucky',
    version: '1.0.0',
    description: 'Adds a Lucky command-bar mode that focuses a random node',
  },
  commandModes: [
    {
      id: 'lucky',
      label: 'Lucky',
      icon: 'Dices',
      description: 'Focus a random node on the canvas',
      shortcut: { key: 'l' },
      component: LuckyMode,
    },
  ],
});

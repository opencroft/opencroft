import { LayoutGrid } from 'lucide-react';
import { useState } from 'react';

import { Button } from '@/components/ui/button';
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover';

export type GridSize = 'tiny' | 'small' | 'medium' | 'large';

interface GridSizeSwitcherProps {
  value: GridSize;
  onChange: (size: GridSize) => void;
  buttonSize?: 'default' | 'sm' | 'lg' | 'icon';
  align?: 'start' | 'center' | 'end';
}

const sizes: { value: GridSize; label: string }[] = [
  { value: 'large', label: 'Large' },
  { value: 'medium', label: 'Medium' },
  { value: 'small', label: 'Small' },
  { value: 'tiny', label: 'Tiny' },
];

export function GridSizeSwitcher({ value, onChange, buttonSize = 'default', align = 'end' }: GridSizeSwitcherProps) {
  const [open, setOpen] = useState(false);

  const handleSelect = (size: GridSize) => {
    onChange(size);
    setOpen(false);
  };

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <Button variant='outline' size={buttonSize}>
          <LayoutGrid className='h-4 w-4' />
        </Button>
      </PopoverTrigger>
      <PopoverContent align={align} className='w-40 p-2'>
        <div className='flex flex-col gap-1'>
          {sizes.map((size) => (
            <Button
              key={size.value}
              variant={value === size.value ? 'default' : 'ghost'}
              size='sm'
              onClick={() => handleSelect(size.value)}
              className='justify-start'
            >
              {size.label}
            </Button>
          ))}
        </div>
      </PopoverContent>
    </Popover>
  );
}

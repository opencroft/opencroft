'use client';

import { Check, ChevronsUpDown, X } from 'lucide-react';
import * as React from 'react';

import { Button } from 'ui/button';
import {
  Command,
  CommandEmpty,
  CommandGroup,
  CommandInput,
  CommandItem,
  CommandList,
} from '@/components/ui/command';
import { Label } from '@/components/ui/label';
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from '@/components/ui/popover';
import { cn } from '@/lib/utils';

interface SearchableDropdownSubgroup {
  label: string;
  options: string[];
}

interface SearchableDropdownGroup {
  label: string;
  options: string[];
  color?: string;
  subgroups?: SearchableDropdownSubgroup[];
}

interface SearchableDropdownProps {
  label?: string;
  value: string;
  onChange: (value: string) => void;
  options?: string[];
  optionColors?: Record<string, string>;
  groups?: SearchableDropdownGroup[];
  placeholder?: string;
  className?: string;
  keepOpenOnSelect?: boolean;
  // Allow committing a typed value that isn't in the options list.
  allowCustom?: boolean;
}

export function SearchableDropdown({
  label,
  value,
  onChange,
  options = [],
  optionColors = {},
  groups = [],
  placeholder = 'Select...',
  className,
  keepOpenOnSelect = false,
  allowCustom = false,
}: SearchableDropdownProps) {
  const [open, setOpen] = React.useState(false);
  const [query, setQuery] = React.useState('');

  const handleClear = (e: React.MouseEvent) => {
    e.stopPropagation();
    onChange('');
  };

  const commit = (next: string) => {
    onChange(next === value ? '' : next);
    if (!keepOpenOnSelect) {
      setOpen(false);
    }
  };

  const trimmed = query.trim();
  const showCustom =
    allowCustom && trimmed.length > 0 && !options.includes(trimmed);

  return (
    <div className={cn('grid gap-2', className)}>
      {label && <Label>{label}</Label>}
      <Popover open={open} onOpenChange={setOpen}>
        <div className="relative">
          <PopoverTrigger asChild>
            <Button
              variant="outline"
              role="combobox"
              aria-expanded={open}
              aria-label="Select option"
              className={cn('w-full justify-between pr-10', !value && 'text-muted-foreground')}
            >
              {value || placeholder}
              <ChevronsUpDown className="ml-2 h-4 w-4 shrink-0 opacity-50" />
            </Button>
          </PopoverTrigger>
          {value && (
            <button
              type="button"
              onClick={handleClear}
              className="absolute right-8 top-1/2 -translate-y-1/2 h-4 w-4 opacity-50 hover:opacity-100 transition-opacity"
              aria-label="Clear selection"
            >
              <X className="h-4 w-4" />
            </button>
          )}
        </div>
        <PopoverContent className="w-auto min-w-[250px] max-w-[600px] p-0" align="start">
          <Command defaultValue={value}>
            <CommandInput placeholder="Search..." value={query} onValueChange={setQuery} />
            <CommandList>
              <CommandEmpty>No results found.</CommandEmpty>
              {showCustom && (
                <CommandGroup>
                  <CommandItem value={trimmed} keywords={[trimmed]} onSelect={() => commit(trimmed)}>
                    Use “{trimmed}”
                  </CommandItem>
                </CommandGroup>
              )}
              {groups.length > 0 ? (
                groups.flatMap((group) => {
                  const items = [];

                  if (group.options.length > 0) {
                    items.push(
                      <CommandGroup key={group.label} heading={group.label}>
                        {group.options.map((option) => (
                          <CommandItem
                            key={option}
                            value={option}
                            keywords={[option, group.label]}
                            onSelect={() => commit(option)}
                            style={group.color ? { color: group.color } : {}}
                          >
                            {option}
                            <Check
                              className={cn(
                                'ml-auto h-4 w-4',
                                value === option ? 'opacity-100' : 'opacity-0'
                              )}
                            />
                          </CommandItem>
                        ))}
                      </CommandGroup>
                    );
                  }

                  if (group.subgroups) {
                    group.subgroups.forEach((subgroup) => {
                      items.push(
                        <CommandGroup key={`${group.label}-${subgroup.label}`} heading={subgroup.label}>
                          {subgroup.options.map((option) => (
                            <CommandItem
                              key={option}
                              value={option}
                              keywords={[option, subgroup.label, group.label]}
                              onSelect={() => commit(option)}
                              style={group.color ? { color: group.color } : {}}
                            >
                              {option}
                              <Check
                                className={cn(
                                  'ml-auto h-4 w-4',
                                  value === option ? 'opacity-100' : 'opacity-0'
                                )}
                              />
                            </CommandItem>
                          ))}
                        </CommandGroup>
                      );
                    });
                  }

                  return items;
                })
              ) : (
                <CommandGroup>
                  {options.map((option) => (
                    <CommandItem
                      key={option}
                      value={option}
                      onSelect={() => commit(option)}
                      style={optionColors[option] ? { color: optionColors[option] } : {}}
                    >
                      {option}
                      <Check
                        className={cn(
                          'ml-auto h-4 w-4',
                          value === option ? 'opacity-100' : 'opacity-0'
                        )}
                      />
                    </CommandItem>
                  ))}
                </CommandGroup>
              )}
            </CommandList>
          </Command>
        </PopoverContent>
      </Popover>
    </div>
  );
}

'use client';

import { Check, ChevronsUpDown, X } from 'lucide-react';
import * as React from 'react';

import { Button } from '@/components/ui/button';
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
}: SearchableDropdownProps) {
  const [open, setOpen] = React.useState(false);

  const handleClear = (e: React.MouseEvent) => {
    e.stopPropagation();
    onChange('');
  };

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
            <CommandInput placeholder="Search..." />
            <CommandList>
              <CommandEmpty>No results found.</CommandEmpty>
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
                            onSelect={() => {
                              onChange(option === value ? '' : option);
                              if (!keepOpenOnSelect) {
                                setOpen(false);
                              }
                            }}
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
                              onSelect={() => {
                                onChange(option === value ? '' : option);
                                if (!keepOpenOnSelect) {
                                  setOpen(false);
                                }
                              }}
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
                      onSelect={() => {
                        onChange(option === value ? '' : option);
                        if (!keepOpenOnSelect) {
                          setOpen(false);
                        }
                      }}
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

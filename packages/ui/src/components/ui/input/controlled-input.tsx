'use client';

import { useEffect, useRef, useState } from 'react';

import { Input } from 'ui/components/ui/input';
import { useDebounce } from 'ui/components/hooks/use-debounce';

export interface ControlledInputProps extends Omit<React.ComponentProps<typeof Input>, 'onChange' | 'onBlur' | 'onKeyDown'> {
  onValueChanged?: (value: string) => void;
  onAccepted?: (value: string) => void;
  value?: string;
}

export function ControlledInput({ value, onValueChanged, onAccepted, ...props }: ControlledInputProps) {
  const [text, setText] = useState('');
  const lastValueRef = useRef(value);

  useEffect(() => {
    setText(value || '');
    if (value !== lastValueRef.current) {
      lastValueRef.current = value;
    }
  }, [value]);

  const debouncedChange = useDebounce((value: string) => {
    if (onValueChanged) {
      onValueChanged(value);
    }
  }, 500);

  const handleChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    const newValue = e.target.value;
    setText(newValue);
    debouncedChange(newValue);
  };

  const handleKeyDown = (e: React.KeyboardEvent<HTMLInputElement>) => {
    if (e.key !== 'Enter') {
      return;
    }

    debouncedChange.cancel();

    if (onValueChanged) {
      onValueChanged(text);
    }
    if (onAccepted) {
      onAccepted(text);
    }
  };

  // Pressing a button moves focus before its click fires, so flushing here
  // hands the parent the typed value before any submit handler reads it.
  // Callers that submit without moving focus (a shortcut, a programmatic
  // submit) must use the value `onAccepted` passes them instead.
  const handleBlur = () => {
    debouncedChange.flush();
  };

  return (
    <Input
      value={text}
      onChange={handleChange}
      onKeyDown={handleKeyDown}
      onBlur={handleBlur}
      {...props}
    />
  );
}

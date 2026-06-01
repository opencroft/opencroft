'use client';

import { useEffect, useState } from 'react';

import { Loader2 } from 'lucide-react';

import { SshKey } from '@/app/(server)/_server/ssh-key';
import { listSshKeys } from '@/app/(ssh)/_server/ssh-keys-actions';
import { Flex } from '@/components/ui/layout/flex';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';

interface SshKeySelectorProps {
  value?: string;
  onChange: (path: string) => void;
}

export function SshKeySelector({ value, onChange }: SshKeySelectorProps) {
  const [keys, setKeys] = useState<SshKey[] | null>(null);

  useEffect(() => {
    listSshKeys().then(setKeys);
  }, []);

  if (!keys) {
    return (
      <Flex row align="center" className="h-9 px-3 text-sm text-muted-foreground">
        <Loader2 className="h-4 w-4 animate-spin mr-2" />
        Loading keys...
      </Flex>
    );
  }

  return (
    <Select value={value || '__none'} onValueChange={(v) => onChange(v === '__none' ? '' : v)}>
      <SelectTrigger>
        <SelectValue placeholder="No key" />
      </SelectTrigger>
      <SelectContent>
        <SelectItem value="__none">No key</SelectItem>
        {keys.map(k => (
          <SelectItem key={k.path} value={k.path}>{k.name}</SelectItem>
        ))}
      </SelectContent>
    </Select>
  );
}

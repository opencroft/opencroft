import { Send } from 'lucide-react';

import { Button } from '@/components/ui/button';
import { Textarea } from '@/components/ui/textarea';
import { Flex } from '@/components/ui/layout/flex';

export interface ChatInputProps {
  value: string;
  onValueChange: (text: string) => void;
  onSend: (text: string) => void;
  placeholder?: string;
  sendIcon?: React.ReactNode;
  menu?: React.ReactNode;
}

export function ChatInput({ value, onValueChange, onSend, placeholder = 'Write a message...', sendIcon = <Send />, menu }: ChatInputProps) {
  const handleSend = () => {
    if (!value.trim()) {
      return;
    }
    const text = value;
    onValueChange('');
    onSend(text);
  };

  const handleKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      handleSend();
    }
  };

  return (
    <Flex row className="w-full items-end bg-background border-t p-2 pr-0">
      <Textarea
        placeholder={placeholder}
        value={value}
        onChange={(e) => onValueChange(e.target.value)}
        onKeyDown={handleKeyDown}
        className="flex-1 resize-none min-h-0 border-0"
      />
      <Button variant={'ghost'} size={'icon-lg'} onClick={handleSend} className=''>
        {sendIcon}
      </Button>
      {menu}
    </Flex>
  );
}

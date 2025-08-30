'use client';

import { Check, Copy, X } from 'lucide-react';
import { useState } from 'react';

import { useAskAI } from '@/components/core/providers/ask-ai-provider';
import { Button } from '@/components/ui/button';
import { ChatInput } from '@/components/ui/chat/chat-input';
import { ChatMessage } from '@/components/ui/chat/chat-message';
import {
  Sidebar,
  SidebarContent,
  SidebarHeader,
  SidebarFooter,
} from '@/components/ui/sidebar';
import { Textarea } from '@/components/ui/textarea';
import { enhancePrompt } from '@/lib/ai-utils';

interface Message {
  role: 'user' | 'assistant';
  content: string;
}

export function AskAISidebar() {
  const { isOpen, content, instruction, onApply, closeChat, setContent } = useAskAI();
  const [messages, setMessages] = useState<Message[]>([]);
  const [userMessage, setUserMessage] = useState('');
  const [isLoading, setIsLoading] = useState(false);
  const [copiedIndex, setCopiedIndex] = useState<number | null>(null);

  const handleSend = async (message: string) => {
    if (!message.trim() || isLoading) {
      return;
    }

    const newUserMessage: Message = { role: 'user', content: message };
    setMessages(prev => [...prev, newUserMessage]);
    setIsLoading(true);

    const loadingMessage: Message = { role: 'assistant', content: '...' };
    setMessages(prev => [...prev, loadingMessage]);

    try {
      const fullInstruction = `${instruction}\n\nOriginal content:\n${content}\n\nUser request: ${message}`;
      const result = await enhancePrompt({
        prompt: content,
        instruction: fullInstruction,
      });

      if (result) {
        setMessages(prev => {
          const updated = [...prev];
          updated[updated.length - 1] = { role: 'assistant', content: result };
          return updated;
        });
      }
    } catch (error) {
      console.error('Failed to get AI response:', error);
      setMessages(prev => {
        const updated = [...prev];
        updated[updated.length - 1] = { role: 'assistant', content: 'Sorry, I encountered an error. Please try again.' };
        return updated;
      });
    } finally {
      setIsLoading(false);
    }
  };

  const handleApply = (result: string) => {
    if (onApply) {
      onApply(result);
      setContent(result);
    }
  };

  const handleCopy = async (text: string, index: number) => {
    await navigator.clipboard.writeText(text);
    setCopiedIndex(index);
    setTimeout(() => setCopiedIndex(null), 2000);
  };

  const handleClose = () => {
    setMessages([]);
    setUserMessage('');
    closeChat();
  };

  if (!isOpen) {
    return null;
  }

  return (
    <Sidebar side="right" variant="sidebar" className="border-l">
      <SidebarHeader>
        <div className="flex items-center justify-between gap-2 px-4 py-2">
          <h2 className="text-lg font-semibold">Ask AI</h2>
          <Button
            variant="ghost"
            size="icon"
            onClick={handleClose}
            className="h-8 w-8"
          >
            <X className="h-4 w-4" />
          </Button>
        </div>
      </SidebarHeader>

      <SidebarContent className="flex flex-col gap-4 p-4">
        <div className="space-y-2">
          <label className="text-sm font-medium">Current Content</label>
          <Textarea
            value={content}
            onChange={(e) => setContent(e.target.value)}
            className="min-h-[100px] resize-none"
            placeholder="Content to modify..."
          />
        </div>

        <div className="flex-1 flex flex-col gap-2 overflow-y-auto">
          <label className="text-sm font-medium">Conversation</label>
          <div className="flex flex-col gap-2">
            {messages.map((msg, index) => (
              <div key={index} className="flex flex-col gap-1">
                <ChatMessage
                  text={msg.content}
                  className={
                    msg.role === 'user'
                      ? 'bg-primary text-primary-foreground ml-auto max-w-[85%]'
                      : 'bg-muted max-w-[85%]'
                  }
                />
                {msg.role === 'assistant' && msg.content !== '...' && (
                  <div className="flex gap-1">
                    <Button
                      variant="ghost"
                      size="sm"
                      onClick={() => handleApply(msg.content)}
                      className="h-7 text-xs"
                    >
                      <Check className="h-3 w-3 mr-1" />
                      Apply
                    </Button>
                    <Button
                      variant="ghost"
                      size="sm"
                      onClick={() => handleCopy(msg.content, index)}
                      className="h-7 text-xs"
                    >
                      {copiedIndex === index ? (
                        <>
                          <Check className="h-3 w-3 mr-1" />
                          Copied
                        </>
                      ) : (
                        <>
                          <Copy className="h-3 w-3 mr-1" />
                          Copy
                        </>
                      )}
                    </Button>
                  </div>
                )}
              </div>
            ))}
          </div>
        </div>
      </SidebarContent>

      <SidebarFooter className="p-4">
        <ChatInput
          value={userMessage}
          onValueChange={setUserMessage}
          onSend={handleSend}
          placeholder="Ask AI to modify the content..."
        />
      </SidebarFooter>
    </Sidebar>
  );
}

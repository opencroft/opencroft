'use client';

import { ChevronLeft, ChevronRight, MessageCircleQuestion, X } from 'lucide-react';
import { type KeyboardEvent, useCallback, useMemo, useState, useTransition } from 'react';

import { answerAskUser, cancelAskUser } from '@/app/(approvals)/actions';
import { useOverlayBar, useOverlayMenu } from '@/app/(dashboard)/_canvas/overlay-context';
import { sseEventsStore } from '@/app/(sse)/stores/sse-events-store';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import type { PendingAskUser, AskUserQuestion } from '@/lib/sse-events';

export function AskUserBar({ request }: { request: PendingAskUser }) {
  const [currentIdx, setCurrentIdx] = useState(0);
  const [answers, setAnswers] = useState<Record<string, string[]>>({});
  const [customText, setCustomText] = useState('');
  const [pending, startTransition] = useTransition();

  const questions = request.questions;
  const question: AskUserQuestion = questions[currentIdx];
  const selected = answers[question.title] ?? [];

  const isLast = currentIdx === questions.length - 1;
  const isAnswered = selected.length > 0 || customText.trim() !== '';

  const toggleOption = useCallback((option: string) => {
    setAnswers((prev) => {
      const current = prev[question.title] ?? [];
      if (question.multiple) {
        const next = current.includes(option)
          ? current.filter((o) => o !== option)
          : [...current, option];
        return { ...prev, [question.title]: next };
      }
      return { ...prev, [question.title]: [option] };
    });
    setCustomText('');
  }, [question]);

  const submitCustom = useCallback(() => {
    const text = customText.trim();
    if (!text) return;
    setAnswers((prev) => {
      if (question.multiple) {
        const current = prev[question.title] ?? [];
        return { ...prev, [question.title]: [...current, text] };
      }
      return { ...prev, [question.title]: [text] };
    });
    setCustomText('');
  }, [question, customText]);

  const submit = useCallback(() => {
    startTransition(async () => {
      const finalAnswers: Record<string, string> = {};
      for (const q of questions) {
        const selected = answers[q.title] ?? [];
        finalAnswers[q.title] = selected.join(', ');
      }
      await answerAskUser(request.id, finalAnswers);
    });
  }, [questions, answers, request.id]);

  const dismiss = useCallback(() => {
    startTransition(async () => {
      await cancelAskUser(request.id);
    });
  }, [request.id]);

  const goNext = useCallback(() => {
    if (isLast) {
      submit();
    } else {
      setCurrentIdx((i) => i + 1);
    }
  }, [isLast, submit]);

  const onCustomKeyDown = useCallback((e: KeyboardEvent<HTMLInputElement>) => {
    if (e.key === 'Enter') {
      e.preventDefault();
      submitCustom();
    }
  }, [submitCustom]);

  const menuNode = useMemo(() => (
    <div className="flex flex-col gap-2 px-3 py-2">
      <div className="flex items-center gap-2 border-b pb-2">
        <MessageCircleQuestion className="h-4 w-4 shrink-0 text-primary" />
        <span className="text-sm font-medium flex-1">{question.question}</span>
        <span className="text-xs text-muted-foreground">{currentIdx + 1}/{questions.length}</span>
      </div>
      <div className="flex flex-col gap-1">
        {question.options.map((option) => {
          const isSelected = selected.includes(option);
          return (
            <Button
              key={option}
              size="sm"
              variant={isSelected ? 'default' : 'outline'}
              className="justify-start w-full"
              onClick={() => toggleOption(option)}
            >
              {option}
            </Button>
          );
        })}
      </div>
      <div className="flex gap-1.5">
        <Input
          value={customText}
          onChange={(e) => setCustomText(e.target.value)}
          onKeyDown={onCustomKeyDown}
          placeholder="Custom answer (Enter)"
          className="h-8 flex-1"
        />
        <Button size="sm" onClick={submitCustom} disabled={!customText.trim()} className="h-8">
          Add
        </Button>
      </div>
      {question.multiple && selected.length > 0 && (
        <div className="text-xs text-muted-foreground">
          Selected: {selected.join(', ')}
        </div>
      )}
      <div className="flex items-center gap-1.5 pt-1">
        <Button
          size="sm"
          variant="ghost"
          onClick={() => setCurrentIdx((i) => Math.max(0, i - 1))}
          disabled={currentIdx === 0}
        >
          <ChevronLeft className="h-4 w-4" />
        </Button>
        <Button
          size="sm"
          onClick={goNext}
          disabled={!isAnswered || pending}
          className="flex-1"
        >
          {isLast ? 'Submit' : 'Next'}
          {!isLast && <ChevronRight className="h-4 w-4" />}
        </Button>
        <Button size="sm" variant="ghost" onClick={dismiss} disabled={pending}>
          <X className="h-4 w-4" />
        </Button>
      </div>
    </div>
  ), [question, questions, currentIdx, selected, customText, isAnswered, isLast, pending, toggleOption, submitCustom, goNext, dismiss, onCustomKeyDown]);

  const barNode = useMemo(() => (
    <div className="flex items-center gap-2 w-full text-xs text-muted-foreground">
      <MessageCircleQuestion className="h-4 w-4 shrink-0 text-primary" />
      <span>Question {currentIdx + 1} of {questions.length}</span>
    </div>
  ), [currentIdx, questions.length]);

  useOverlayMenu(menuNode);
  useOverlayBar(barNode);

  return null;
}

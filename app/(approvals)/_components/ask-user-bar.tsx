'use client'

import { Check, MessageCircleQuestion, X } from 'lucide-react'
import { type KeyboardEvent, useCallback, useMemo, useState, useTransition } from 'react'

import { answerAskUser, cancelAskUser } from '@/app/(approvals)/_server/actions'
import { useOverlayBar, useOverlayMenu } from '@/app/(dashboard)/_canvas/overlay-context'
import { Button } from '@/components/ui/button'
import { Checkbox } from '@/components/ui/checkbox'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { RadioGroup, RadioGroupItem } from '@/components/ui/radio-group'
import type { PendingAskUser } from '@/lib/sse-events'

const CUSTOM_VALUE = '__custom__'

/** Check if a question has an answer (options selected or custom text typed). */
function isQuestionAnswered(title: string, answers: Record<string, string[]>, customTexts: Record<string, string>): boolean {
  return (answers[title] ?? []).length > 0 || (customTexts[title] ?? '').trim() !== ''
}

export function AskUserBar({ request }: { request: PendingAskUser }) {
  const [currentIdx, setCurrentIdx] = useState(0)
  const [answers, setAnswers] = useState<Record<string, string[]>>({})
  const [customTexts, setCustomTexts] = useState<Record<string, string>>({})
  const [pending, startTransition] = useTransition()

  const questions = request.questions
  const question = questions[currentIdx]
  const title = question.title
  const selected = answers[title] ?? []
  const customText = customTexts[title] ?? ''
  const isLast = currentIdx === questions.length - 1
  const answered = isQuestionAnswered(title, answers, customTexts)
  const allAnswered = questions.every((q) => isQuestionAnswered(q.title, answers, customTexts))

  // ── State helpers ──────────────────────────────────────────────────────

  const updateCustomText = useCallback(
    (value: string) => {
      setCustomTexts((prev) => ({ ...prev, [title]: value }))
    },
    [title],
  )

  const toggleOption = useCallback(
    (option: string) => {
      setAnswers((prev) => {
        const current = prev[title] ?? []
        if (question.multiple) {
          return current.includes(option) ? { ...prev, [title]: current.filter((o) => o !== option) } : { ...prev, [title]: [...current, option] }
        }
        return { ...prev, [title]: [option] }
      })
      if (!question.multiple) {
        setCustomTexts((prev) => ({ ...prev, [title]: '' }))
      }
    },
    [title, question.multiple],
  )

  /** Commit pending custom text for current question into answers. */
  const commitCustom = useCallback(() => {
    const text = customText.trim()
    if (!text) {
      return
    }
    setAnswers((prev) => {
      const current = prev[title] ?? []
      if (question.multiple) {
        return current.includes(text) ? prev : { ...prev, [title]: [...current, text] }
      }
      return { ...prev, [title]: [text] }
    })
    setCustomTexts((prev) => ({ ...prev, [title]: '' }))
  }, [customText, title, question.multiple])

  // ── Resolve all answers into final string map ──────────────────────────

  const buildFinalAnswers = useCallback((): Record<string, string> => {
    const result: Record<string, string> = {}
    for (const q of questions) {
      const sel = (answers[q.title] ?? []).map((s) => (s === CUSTOM_VALUE ? (customTexts[q.title] ?? '').trim() : s)).filter(Boolean)
      result[q.title] = sel.join(', ')
    }
    return result
  }, [questions, answers, customTexts])

  // ── Actions ────────────────────────────────────────────────────────────

  const submit = useCallback(() => {
    startTransition(async () => {
      await answerAskUser({ data: { id: request.id, answers: buildFinalAnswers() } })
    })
  }, [request.id, buildFinalAnswers])

  /** Commit pending text, then advance to next tab or submit. */
  const advance = useCallback(() => {
    commitCustom()
    if (isLast) {
      submit()
    } else {
      setCurrentIdx((i) => i + 1)
    }
  }, [commitCustom, isLast, submit])

  const dismiss = useCallback(() => {
    startTransition(async () => {
      await cancelAskUser({ data: request.id })
    })
  }, [request.id])

  const onCustomKeyDown = useCallback(
    (e: KeyboardEvent<HTMLInputElement>) => {
      if (e.key === 'Enter') {
        e.preventDefault()
        advance()
      }
    },
    [advance],
  )

  // ── Render ─────────────────────────────────────────────────────────────

  const selectedKey = selected.join(',')
  const stateKey = `${currentIdx}|${selectedKey}|${customText}|${pending ? 1 : 0}`

  const menuNode = useMemo(
    () => (
      <div className='flex flex-col gap-2 px-3 py-2'>
        {/* Header */}
        <div className='flex items-center gap-2'>
          <MessageCircleQuestion className='h-4 w-4 shrink-0 text-primary' />
          <span className='text-sm font-medium flex-1'>Questions</span>
          <Button size='sm' variant='ghost' onClick={dismiss} disabled={pending} className='h-6 w-6 p-0'>
            <X className='h-4 w-4' />
          </Button>
        </div>

        {/* Tabs */}
        <div className='flex items-center gap-0 -mx-3 px-3 border-b'>
          {questions.map((q, idx) => (
            <button
              key={q.title}
              type='button'
              onClick={() => setCurrentIdx(idx)}
              className={[
                'flex items-center gap-1.5 px-2.5 py-1.5 text-xs font-medium border-b-2 transition-colors',
                currentIdx === idx ? 'border-primary text-foreground' : 'border-transparent text-muted-foreground hover:text-foreground/80',
              ].join(' ')}
            >
              {isQuestionAnswered(q.title, answers, customTexts) && <Check className='size-3 text-primary' />}
              {q.title}
            </button>
          ))}
        </div>

        {/* Question */}
        <div className='text-sm text-muted-foreground'>{question.question}</div>

        {/* Options */}
        {question.multiple ? (
          <div className='flex flex-col gap-1.5'>
            {question.options.map((option) => (
              <div key={option} className='flex items-center gap-2'>
                <Checkbox id={`opt-${option}`} checked={selected.includes(option)} onCheckedChange={() => toggleOption(option)} />
                <Label htmlFor={`opt-${option}`} className='text-sm cursor-pointer'>
                  {option}
                </Label>
              </div>
            ))}
            {selected
              .filter((s) => !question.options.includes(s))
              .map((custom) => (
                <div key={custom} className='flex items-center gap-2'>
                  <Checkbox checked onCheckedChange={() => toggleOption(custom)} />
                  <Label className='text-sm'>{custom}</Label>
                </div>
              ))}
            <Input value={customText} onChange={(e) => updateCustomText(e.target.value)} onKeyDown={onCustomKeyDown} placeholder='Custom answer (Enter to add)' className='h-8 mt-1' />
          </div>
        ) : (
          <RadioGroup
            value={selected[0] ?? ''}
            onValueChange={(val) => {
              if (val !== CUSTOM_VALUE) {
                toggleOption(val)
              }
            }}
            className='gap-1.5'
          >
            {question.options.map((option) => (
              <div key={option} className='flex items-center gap-2'>
                <RadioGroupItem value={option} id={`opt-${option}`} />
                <Label htmlFor={`opt-${option}`} className='text-sm cursor-pointer'>
                  {option}
                </Label>
              </div>
            ))}
            <div className='flex items-center gap-2'>
              <RadioGroupItem value={CUSTOM_VALUE} id='opt-custom' />
              <Input
                value={customText}
                onChange={(e) => updateCustomText(e.target.value)}
                onFocus={() => setAnswers((prev) => ({ ...prev, [title]: [CUSTOM_VALUE] }))}
                onKeyDown={onCustomKeyDown}
                placeholder='Custom answer (Enter to submit)'
                className='h-8 flex-1'
              />
            </div>
          </RadioGroup>
        )}

        {/* Next / Submit */}
        {!isLast ? (
          <Button size='sm' onClick={advance} disabled={!answered || pending} className='w-full'>
            Next
          </Button>
        ) : (
          <Button size='sm' onClick={advance} disabled={!allAnswered || pending} className='w-full'>
            Submit
          </Button>
        )}
      </div>
      // eslint-disable-next-line react-hooks/exhaustive-deps
    ),
    [stateKey, allAnswered],
  )

  const barNode = useMemo(
    () => (
      <div className='flex items-center gap-2 w-full text-xs text-muted-foreground'>
        <MessageCircleQuestion className='h-4 w-4 shrink-0 text-primary' />
        <span>
          Question {currentIdx + 1} of {questions.length}
        </span>
      </div>
    ),
    [currentIdx, questions.length],
  )

  useOverlayMenu(menuNode)
  useOverlayBar(barNode)

  return null
}

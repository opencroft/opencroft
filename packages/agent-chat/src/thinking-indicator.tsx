'use client'

import { useEffect, useRef, useState } from 'react'
import { TypingDots } from 'ui/components/ui/chat/typing-dots'
import { Flex } from 'ui/components/ui/layout/flex'

// Distinct from `ThinkingBlock` (thinking-block.tsx), which renders the
// agent's actual streamed reasoning text — this is a content-free "still
// working" indicator shown while a turn is active but hasn't produced
// anything to render yet.
const THINKING_PHRASES = [
  'Analyzing...',
  'Architecting...',
  'Brewing...',
  'Casting...',
  'Consulting...',
  'Cooking...',
  'Crunching...',
  'Doing the THING...',
  'Figuring...',
  'Masterminding...',
  'Orchestrating...',
  'Pondering...',
  'Processing...',
  'Slacking...',
  'Snoozing...',
  'Sorcering...',
  'Thinking...',
  'Vibing...',
  'Witching...',
  'Working...',
] as const

// A typing-dots indicator with a rotating phrase that types itself over the
// previous one, character by character. Purely decorative — no props, no
// state a host needs to manage — so it can drop in anywhere a turn is active.
export function ThinkingIndicator() {
  const [phrase, setPhrase] = useState<string>(
    () => THINKING_PHRASES[Math.floor(Math.random() * THINKING_PHRASES.length)],
  )
  const prevPhrase = useRef(phrase)
  const [visible, setVisible] = useState(0)

  // Cycle phrases every few seconds.
  useEffect(() => {
    const interval = setInterval(() => {
      let next: string
      do {
        next = THINKING_PHRASES[Math.floor(Math.random() * THINKING_PHRASES.length)]
      } while (next === phrase && next.length === phrase.length && THINKING_PHRASES.length > 1)
      prevPhrase.current = phrase
      setPhrase(next)
      setVisible(0)
    }, 3000)
    return () => clearInterval(interval)
  }, [phrase])

  const maxLen = Math.max(phrase.length, prevPhrase.current.length)

  // Typewriter effect: reveal the new phrase character by character.
  useEffect(() => {
    let i = 0
    let cancelled = false
    const tick = () => {
      if (cancelled) return
      i++
      if (i <= maxLen) {
        setVisible(i)
        setTimeout(tick, 20 + Math.random() * 60)
      }
    }
    setTimeout(tick, 300)
    return () => {
      cancelled = true
    }
  }, [phrase, maxLen])

  // Compose display: new text overwrites old character by character.
  const paddedNew = phrase.padEnd(maxLen)
  const paddedOld = prevPhrase.current.padEnd(maxLen)
  const display = paddedNew.slice(0, visible) + paddedOld.slice(visible)

  return (
    <Flex row align='center' className='gap-2 text-xs text-muted-foreground font-mono'>
      <TypingDots variant='primary' size='sm' />
      <span>{display.trimEnd()}</span>
    </Flex>
  )
}

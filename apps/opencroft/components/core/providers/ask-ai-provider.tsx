'use client'

import { createContext, type ReactNode, useContext, useState } from 'react'

interface AskAIContextValue {
  isOpen: boolean
  content: string
  instruction: string
  onApply: ((result: string) => void) | null
  openChat: (content: string, instruction: string, onApply: (result: string) => void) => void
  closeChat: () => void
  setContent: (content: string) => void
}

const AskAIContext = createContext<AskAIContextValue | null>(null)

interface AskAIProviderProps {
  children: ReactNode
}

export function AskAIProvider({ children }: AskAIProviderProps) {
  const [isOpen, setIsOpen] = useState(false)
  const [content, setContent] = useState('')
  const [instruction, setInstruction] = useState('')
  const [onApply, setOnApply] = useState<((result: string) => void) | null>(null)

  const openChat = (newContent: string, newInstruction: string, applyCallback: (result: string) => void) => {
    setContent(newContent)
    setInstruction(newInstruction)
    setOnApply(() => applyCallback)
    setIsOpen(true)
  }

  const closeChat = () => {
    setIsOpen(false)
  }

  return (
    <AskAIContext.Provider
      value={{
        isOpen,
        content,
        instruction,
        onApply,
        openChat,
        closeChat,
        setContent,
      }}
    >
      {children}
    </AskAIContext.Provider>
  )
}

export function useAskAI() {
  const context = useContext(AskAIContext)
  if (!context) {
    throw new Error('useAskAI must be used within AskAIProvider')
  }
  return context
}

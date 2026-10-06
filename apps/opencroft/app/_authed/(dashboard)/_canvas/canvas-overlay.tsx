'use client'

import { cn } from 'cn'
import { type LucideIcon, Puzzle, X } from 'lucide-react'
import type * as React from 'react'
import { useCallback, useEffect, useMemo, useRef } from 'react'
import { Flex } from 'ui/layout/flex'

import { type CommandNodeEntry, NO_COMMAND_MODE } from '@/app/_authed/(dashboard)/_canvas/canvas-command-bar'
import { CommandBar, CommandBarMenu } from '@/app/_authed/(dashboard)/_canvas/command-bar'
import { recordBubbled, recordCaptured, recordRender } from '@/app/_authed/(dashboard)/_canvas/ctrlg-debug'
import { ChatArea, ChatBar, ChatContent, ChatHeader } from '@/app/_authed/(dashboard)/_canvas/overlay-chrome'
import {
  useOverlay,
  useOverlayBackIntercept,
  useOverlaySlotValues,
} from '@/app/_authed/(dashboard)/_canvas/overlay-context'
import { SearchFindBar } from '@/app/_authed/(dashboard)/_canvas/search-find-bar'
import type { CommandModeDefinition, CommandModeShortcut } from '@/app/_authed/(extension-runtime)/_client/host'
import { extensionRegistry, resolveIcon } from '@/app/_authed/(extension-runtime)/_client/registry'

interface CanvasOverlayProps {
  nodes: CommandNodeEntry[]
  spaceName: string
  selectedNodeId: string | null
  onFocusNode: (nodeId: string) => void
  onActiveChange?: (active: boolean) => void
  // Bumped once extension loading settles (see flow-editor.tsx) — commandModes
  // below is a copy taken from the registry, which itself does not trigger a
  // re-render when an extension registers into it after this component's
  // first render, so its memo has to depend on something that does.
  extensionsVersion: number
}

/**
 * The `KeyboardEvent.code` a declared shortcut resolves to, or undefined if
 * it names nothing usable.
 *
 * A compiled extension bundle built before shortcuts moved to `code` (see
 * CommandModeShortcut's own doc comment) declares the old `{ key: 'g' }`
 * shape — a character, not a physical key. Installed bundles keep running
 * exactly as compiled and are not touched by an app deploy, so `sc.code` is
 * undefined for one of those until it is reinstalled from a source that
 * declares the new field (a separate migration, tracked apart from this).
 * Falling back to the legacy field here, converted to the code it always
 * meant, is what keeps that extension's shortcut alive in the meantime
 * instead of it going silently dead — exactly the failure this file exists
 * to fix.
 *
 * Read via an explicitly-typed legacy shape rather than widening
 * CommandModeShortcut itself, so every NEW declaration is still forced onto
 * the code-only contract. Letters only: the old field was never used for
 * anything else, so a legacy digit or punctuation shortcut (never actually
 * declared by anything) is left unresolved rather than guessed at.
 */
export function resolveShortcutCode(sc: CommandModeShortcut): string | undefined {
  if (sc.code) {
    return sc.code
  }
  const legacyKey = (sc as unknown as { key?: unknown }).key
  return typeof legacyKey === 'string' && /^[a-zA-Z]$/.test(legacyKey) ? `Key${legacyKey.toUpperCase()}` : undefined
}

export function CanvasOverlay({
  nodes,
  spaceName,
  selectedNodeId,
  onFocusNode,
  onActiveChange,
  extensionsVersion,
}: CanvasOverlayProps) {
  const {
    mode,
    params: modeParams,
    focusTick,
    slots,
    activate: activateMode,
    dismiss: dismissOverlay,
    setMode,
    setCommandFocused,
  } = useOverlay()
  // This is the surface that paints the slots, so it is the one place that
  // subscribes to their values — see useOverlaySlotValues.
  const slotValues = useOverlaySlotValues()

  const extensionModes = useMemo(() => {
    void extensionsVersion
    return extensionRegistry.allCommandModes()
  }, [extensionsVersion])

  // Matched on `event.code` (the physical key), not `event.key` (the
  // character it produces) — on a non-QWERTY layout the same physical F/P/I
  // keys sit in the same place but produce a different character, so a
  // `key`-based match silently never fires. `code` is layout-independent by
  // construction: `KeyF` is `KeyF` everywhere. Same reasoning for extension
  // shortcuts below — see CommandModeShortcut's `code` field.
  // TEMPORARY: capture-phase probe registered once, independent
  // of onKey's own bubble-phase listener -- proves whether a keydown reaches
  // window at all and via what DOM path, regardless of what onKey does with it.
  useEffect(() => {
    function onCapture(event: globalThis.KeyboardEvent) {
      if (event.ctrlKey || event.metaKey) {
        recordCaptured(event)
      }
    }
    window.addEventListener('keydown', onCapture, true)
    return () => window.removeEventListener('keydown', onCapture, true)
  }, [])

  useEffect(() => {
    function onKey(event: globalThis.KeyboardEvent) {
      if (!(event.ctrlKey || event.metaKey)) {
        return
      }
      const code = event.code
      if (code === 'KeyF' || code === 'KeyP') {
        event.preventDefault()
        activateMode(code === 'KeyF' ? 'search' : 'find')
        return
      }
      let matched: string | null = null
      for (const ext of extensionModes) {
        const sc = ext.shortcut
        if (!sc || resolveShortcutCode(sc) !== code) {
          continue
        }
        if (Boolean(sc.shift) !== event.shiftKey) {
          continue
        }
        if (Boolean(sc.alt) !== event.altKey) {
          continue
        }
        matched = ext.id
        break
      }
      // TEMPORARY: record every attempt, matched or not --
      // an unmatched attempt with extensionModes already containing the
      // expected id would point at the shift/alt guards or resolveShortcutCode
      // itself rather than a registration-timing race.
      recordBubbled(
        code,
        extensionModes.map((m) => m.id),
        matched,
      )
      if (matched) {
        event.preventDefault()
        activateMode(matched)
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [extensionModes, activateMode])

  const resetMode = useCallback(() => {
    setMode(NO_COMMAND_MODE)
  }, [setMode])

  // Notify parent when overlay content or header is active
  const prevActive = useRef(false)
  useEffect(() => {
    const active = !!(slotValues.content || slotValues.header)
    if (active !== prevActive.current) {
      prevActive.current = active
      onActiveChange?.(active)
    }
  }, [slotValues.content, slotValues.header, onActiveChange])

  const overlayActive = !!(slotValues.content || slotValues.header)

  const dismiss = dismissOverlay

  useOverlayBackIntercept(overlayActive, dismiss)

  const onOverlayMouseDown = useCallback(() => {
    dismiss()
  }, [dismiss])

  const onOverlayKeyDown = useCallback(
    (event: React.KeyboardEvent<HTMLDivElement>) => {
      if (event.key === 'Escape') {
        event.stopPropagation()
        dismiss()
      }
    },
    [dismiss],
  )

  const stopOverlayClose = useCallback((event: React.MouseEvent<HTMLDivElement>) => {
    event.stopPropagation()
  }, [])

  const activeExtMode = useMemo(() => extensionModes.find((m) => m.id === mode), [extensionModes, mode])

  // TEMPORARY: every render's mode/overlayActive, unconditionally
  // (not in an effect) -- so a mode that flips back before the content slot is
  // ever painted shows up here, correlated against managerCalls's transition log.
  recordRender(mode, !!activeExtMode, overlayActive)

  // Nothing at rest: the canvas carries no command surface of its own, and an
  // id matching no registered extension paints nothing rather than falling
  // back to a bar the reader never asked for.
  const activeMode = (() => {
    if (mode === 'search' || mode === 'find') {
      return (
        <SearchFindBar
          mode={mode}
          nodes={nodes}
          focusTick={focusTick}
          onFocusNode={onFocusNode}
          onFocusChange={setCommandFocused}
          onReset={resetMode}
        />
      )
    }
    if (activeExtMode) {
      const ModeComponent = activeExtMode.component
      return (
        <ModeComponent
          nodes={nodes}
          spaceName={spaceName}
          selectedNodeId={selectedNodeId}
          focusTick={focusTick}
          params={modeParams}
          onFocusNode={onFocusNode}
          onClose={resetMode}
          onFocusChange={setCommandFocused}
        />
      )
    }
    return null
  })()

  return (
    <>
      {activeMode}
      <Flex
        row
        ref={slots.containerRef as React.RefObject<HTMLDivElement>}
        tabIndex={-1}
        onMouseDown={onOverlayMouseDown}
        onKeyDown={onOverlayKeyDown}
        className={cn(
          'absolute inset-0 z-10',
          slotValues.content || slotValues.menu ? 'pointer-events-auto' : 'pointer-events-none',
        )}
      >
        <div
          className={cn(
            'pointer-events-none absolute inset-0',
            'bg-background/80 transition-opacity duration-200',
            slotValues.content ? 'opacity-100' : 'opacity-0',
          )}
        />
        <div className='absolute top-3 left-3 z-20'>
          <ExtensionModeLaunchers
            modes={extensionModes}
            activeId={mode}
            onActivate={activateMode}
            onDeactivate={dismiss}
          />
        </div>
        {slotValues.content && (
          <button
            type='button'
            title='Close overlay'
            aria-label='Close overlay'
            onMouseDown={(e) => e.stopPropagation()}
            onClick={dismiss}
            className='absolute top-3 right-3 z-20 pointer-events-auto size-7 inline-flex items-center justify-center rounded-md border bg-background/90 hover:bg-accent cursor-pointer'
          >
            <X className='size-4' />
          </button>
        )}
        <ChatArea>
          <ChatHeader fade={!!slotValues.content} onMouseDown={stopOverlayClose}>
            {slotValues.header}
          </ChatHeader>
          <ChatContent
            compact={!activeExtMode?.fullWidth}
            className={cn(
              'bg-background rounded-xl',
              'transition-opacity duration-200',
              slotValues.content ? 'opacity-100' : 'opacity-0',
            )}
            onMouseDown={stopOverlayClose}
          >
            {slotValues.content}
          </ChatContent>
          <ChatBar compact fade={!!slotValues.content} onMouseDown={stopOverlayClose}>
            {slotValues.menu && <CommandBarMenu>{slotValues.menu}</CommandBarMenu>}
            {slotValues.bar && <CommandBar>{slotValues.bar}</CommandBar>}
          </ChatBar>
        </ChatArea>
      </Flex>
    </>
  )
}

function modeIcon(name?: string): LucideIcon {
  return resolveIcon(name, Puzzle)
}

// Launcher buttons for extension command modes, pinned to the overlay's top-left corner.
// Clicking the active mode's button closes it again (toggle).
function ExtensionModeLaunchers({
  modes,
  activeId,
  onActivate,
  onDeactivate,
}: {
  modes: CommandModeDefinition[]
  activeId: string
  onActivate: (id: string) => void
  onDeactivate: () => void
}) {
  if (modes.length === 0) {
    return null
  }
  return (
    <div className='flex items-center gap-1 pointer-events-auto'>
      {modes.map((m) => {
        const Icon = modeIcon(m.icon)
        const active = activeId === m.id
        return (
          <button
            key={m.id}
            type='button'
            title={m.label}
            onMouseDown={(e) => e.stopPropagation()}
            onClick={() => (active ? onDeactivate() : onActivate(m.id))}
            className={cn(
              'size-7 inline-flex items-center justify-center rounded-md border bg-background/90 hover:bg-accent cursor-pointer',
              active && 'bg-accent',
            )}
          >
            <Icon className='size-4' />
          </button>
        )
      })}
    </div>
  )
}

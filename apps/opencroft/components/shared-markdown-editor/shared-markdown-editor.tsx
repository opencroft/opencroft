'use client'

import { HocuspocusProvider } from '@hocuspocus/provider'
import { useSession } from '@opencroft/auth/client'
import type { AnyExtension } from '@tiptap/core'
import { Collaboration } from '@tiptap/extension-collaboration'
import { CollaborationCaret } from '@tiptap/extension-collaboration-caret'
import { MarkdownEditor, type MarkdownEditorSurfaceProps } from 'agent-chat/markdown-editor'
import { useEffect, useMemo, useState } from 'react'
import {
  collaboratorCaretElement,
  collaboratorHue,
  collaboratorSelectionStyle,
  collaboratorTagElement,
  hueFor,
} from 'ui/components/ui/editing/collaborator-caret'
import { MemberAvatarGroup, type MemberRef } from 'ui/components/ui/group-chat/member-avatar-group'
import type { PaletteHue } from 'ui/components/ui/input/color-palette'
import * as Y from 'yjs'

import { openMarkdownDoc } from '@/app/_authed/(collab)/_server/actions'
import { BlockPresence } from '@/components/shared-markdown-editor/block-presence'
import { EditPlayback } from '@/components/shared-markdown-editor/edit-playback'
import { OneStepUndo } from '@/components/shared-markdown-editor/one-step-undo'
import { stayConnected } from '@/components/shared-markdown-editor/stay-connected'
import { type CollabSession, collabSocketUrl } from '@/lib/collab-protocol'
import { MARKDOWN_DOC_FIELD, type MarkdownEditOrigin } from '@/lib/markdown-doc-protocol'

/** Who an editor is, as it tells the others: the awareness state's `user`. */
interface Collaborator {
  id: string
  name: string
  hue: PaletteHue
}

/** Another editor's announced `user`, checked: it comes from another client. */
function collaboratorOf(value: unknown): Collaborator | null {
  const user = value as { id?: unknown; name?: unknown; hue?: unknown } | undefined
  const hue = collaboratorHue(user?.hue)
  return typeof user?.id === 'string' && typeof user.name === 'string' && hue
    ? { id: user.id, name: user.name, hue }
    : null
}

/** One open connection to a shared document. */
interface Connection {
  session: CollabSession
  doc: Y.Doc
  provider: HocuspocusProvider
}

export interface SharedMarkdownEditorProps extends MarkdownEditorSurfaceProps {
  /** The document's name, as its owner hands it out. */
  document: string
}

/**
 * The markdown editor bound to a document several people edit at once. Shows
 * who else has it open -- their avatars beside the toolbar's own controls,
 * their carets and selections in the text, and their tags on the blocks whose
 * own controls they are in -- plays back changes made from
 * outside an editor, and keeps an undo history of this editor's changes only.
 */
export function SharedMarkdownEditor({ document: docName, toolbarExtra, ...surface }: SharedMarkdownEditorProps) {
  const { data: auth } = useSession()
  const me = auth?.user
  const [opening, setOpening] = useState(0)
  const [session, setSession] = useState<CollabSession | null | undefined>(undefined)

  // A fresh session each time the server says the copy is stale: the document
  // was rebuilt from its stored markdown, and the old copy must be dropped.
  // biome-ignore lint/correctness/useExhaustiveDependencies(opening): not read in the body -- it exists to re-open the same document when the server refuses a stale copy
  useEffect(() => {
    let current = true
    setSession(undefined)
    openMarkdownDoc({ data: docName }).then(
      (opened) => current && setSession(opened),
      () => current && setSession(null),
    )
    return () => {
      current = false
    }
  }, [docName, opening])

  const [connection, setConnection] = useState<Connection | null>(null)
  useEffect(() => {
    if (!session) {
      return
    }
    const doc = new Y.Doc()
    let synced = false
    const provider = new HocuspocusProvider({
      url: collabSocketUrl(),
      name: session.docName,
      document: doc,
      token: session.lineage,
      // The editor is bound only once the copy holds the document: bound to an
      // empty copy, it would write an empty paragraph into the shared one.
      onSynced: () => {
        if (!synced) {
          synced = true
          setConnection({ session, doc, provider })
        }
      },
    })
    // A stale copy -- refused at once, or after the server closed the document
    // and rebuilt it -- is dropped for a fresh session.
    const stop = stayConnected(provider, { onStale: () => setOpening((n) => n + 1) })
    return () => {
      stop()
      setConnection(null)
      provider.destroy()
      doc.destroy()
    }
  }, [session])

  const [present, setPresent] = useState<Collaborator[]>([])
  useEffect(() => {
    const awareness = connection?.provider.awareness
    if (!awareness) {
      return
    }
    const update = () => {
      const others = new Map<string, Collaborator>()
      for (const [clientId, state] of awareness.getStates()) {
        const collaborator = clientId === awareness.clientID ? null : collaboratorOf(state.user)
        if (collaborator && collaborator.id !== me?.id) {
          others.set(collaborator.id, collaborator)
        }
      }
      setPresent([...others.values()])
    }
    update()
    awareness.on('change', update)
    return () => awareness.off('change', update)
  }, [connection, me?.id])

  const [playing, setPlaying] = useState<MarkdownEditOrigin[]>([])

  const collaboration = useMemo<AnyExtension[] | null>(() => {
    if (!connection || !me) {
      return null
    }
    const user: Collaborator = { id: me.id, name: me.name, hue: hueFor(me.id) }
    return [
      Collaboration.configure({ document: connection.doc, field: MARKDOWN_DOC_FIELD }),
      CollaborationCaret.configure({
        provider: connection.provider,
        user,
        // Drawn only for an editor that announced who it is; anything else
        // gets an empty element and no selection.
        render: (state) => {
          const collaborator = collaboratorOf(state)
          return collaborator
            ? collaboratorCaretElement(collaborator.name, collaborator.hue)
            : document.createElement('span')
        },
        selectionRender: (state) => {
          const collaborator = collaboratorOf(state)
          return collaborator ? { style: collaboratorSelectionStyle(collaborator.hue) } : {}
        },
      }),
      BlockPresence.configure({
        awareness: connection.provider.awareness,
        render: (state, anchor) => {
          const collaborator = collaboratorOf(state)
          return collaborator && collaboratorTagElement(collaborator.name, collaborator.hue, anchor)
        },
      }),
      // After the binding, whose undo and redo it replaces.
      OneStepUndo,
      EditPlayback.configure({ provider: connection.provider, onPlaying: setPlaying }),
    ]
  }, [connection, me])

  const members: MemberRef[] = [
    ...present.map((collaborator) => ({ kind: 'user' as const, id: collaborator.id, name: collaborator.name })),
    ...playing.map((origin) => ({
      kind: origin.kind === 'agent' ? ('agent' as const) : ('user' as const),
      id: `${origin.kind}:${origin.name}`,
      name: origin.name,
    })),
  ]

  if (session === null) {
    return <p className='p-3 text-sm text-muted-foreground'>This document cannot be opened.</p>
  }
  if (!collaboration || !connection) {
    // Same box, so the surface does not jump when the editor arrives.
    return <div className='rounded-md border bg-background min-h-40' />
  }
  return (
    <MarkdownEditor
      // A new connection is a new document: the editor binds to it afresh.
      key={connection.session.lineage}
      collaboration={collaboration}
      toolbarExtra={
        <>
          {members.length > 0 ? <MemberAvatarGroup members={members} /> : null}
          {toolbarExtra}
        </>
      }
      {...surface}
    />
  )
}

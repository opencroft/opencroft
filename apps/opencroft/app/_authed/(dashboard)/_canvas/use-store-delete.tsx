'use client'

import type { Edge, Node, OnBeforeDelete } from '@xyflow/react'
import { type ReactNode, useCallback, useState } from 'react'
import { toast } from 'sonner'
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from 'ui/alert-dialog'

import { listStoresDeleted, purgeStores } from '@/app/_authed/(dashboard)/_canvas/store-delete-actions'
import { SecretReferenceList } from '@/app/_authed/(secrets-store)/_components/secret-reference-list'
import type { PurgeOutcome, StoreHolding, StoresDeleted } from '@/server/store-purge'

interface PendingPurge {
  deleted: StoresDeleted
  answer: (confirmed: boolean) => void
}

function counted(n: number, one: string, many: string): string {
  return n === 1 ? `1 ${one}` : `${n} ${many}`
}

function namesOf(stores: StoreHolding[]): string[] {
  return stores.flatMap((store) => store.keys)
}

/** "The Secrets Store you are deleting holds A, B." for one kind of store, or null when none holds anything. */
function holdsSentence(stores: StoreHolding[], kind: string): string | null {
  if (stores.length === 0) {
    return null
  }
  const subject = stores.length === 1 ? `The ${kind} you are deleting holds` : `The ${kind}s you are deleting hold`
  return `${subject} ${namesOf(stores).join(', ')}.`
}

/**
 * Deleting a node that owns stored secrets or SSH keys (a Secrets Store, a Key Store) deletes them
 * too, once the user has confirmed it; a deleted secret or key cannot be recovered. What the nodes
 * hold is read from the stores themselves, not from the nodes' indexes of them. A refusal, or a
 * purge that fails, keeps every node of the deletion.
 *
 * The confirm lists the nodes and Apps that still name one of the secrets or keys, which stop
 * resolving it, and is then a "delete anyway". It warns rather than refuses: the person deleting
 * is there to decide. The purge goes past exactly the nodes and Apps it listed: one that started
 * naming something while the confirm was open refuses it, and the confirm opens again listing it.
 *
 * Only a deletion asks. A cut removes the node to paste it again under the same id, and what it
 * holds waits for it.
 */
export function useStoreDelete(): { onBeforeDelete: OnBeforeDelete<Node, Edge>; dialog: ReactNode } {
  const [pending, setPending] = useState<PendingPurge | null>(null)

  const onBeforeDelete = useCallback<OnBeforeDelete<Node, Edge>>(async ({ nodes }) => {
    if (nodes.length === 0) {
      return true
    }
    const deleting = nodes.map((node) => node.id)
    let deleted: StoresDeleted
    try {
      deleted = await listStoresDeleted({ data: { deleting } })
    } catch (err) {
      toast.error(`Could not check the nodes for stored secrets and keys: ${String(err)}`)
      return false
    }
    if (deleted.secretStores.length === 0 && deleted.keyStores.length === 0) {
      return true
    }
    for (;;) {
      const listed = deleted
      const confirmed = await new Promise<boolean>((answer) => setPending({ deleted: listed, answer }))
      setPending(null)
      if (!confirmed) {
        return false
      }
      const shown = [...listed.named.secrets, ...listed.named.keys].flatMap(({ references }) =>
        references.map((ref) => ref.nodeId),
      )
      let outcome: PurgeOutcome
      try {
        outcome = await purgeStores({ data: { deleting, shown } })
      } catch (err) {
        toast.error(`Could not delete the stored secrets and keys: ${String(err)}`)
        return false
      }
      if (!('refused' in outcome)) {
        return true
      }
      deleted = { ...listed, named: outcome.refused }
    }
  }, [])

  const secretNames = namesOf(pending?.deleted.secretStores ?? [])
  const keyNames = namesOf(pending?.deleted.keyStores ?? [])
  const namedSecrets = pending?.deleted.named.secrets ?? []
  const namedKeys = pending?.deleted.named.keys ?? []
  const anyNamed = namedSecrets.length > 0 || namedKeys.length > 0
  const oneStore = (pending?.deleted.secretStores.length ?? 0) + (pending?.deleted.keyStores.length ?? 0) === 1
  const losing = [
    secretNames.length > 0 ? counted(secretNames.length, 'secret', 'secrets') : null,
    keyNames.length > 0 ? counted(keyNames.length, 'SSH key', 'SSH keys') : null,
  ].filter((part) => part !== null)
  const dialog = (
    <AlertDialog
      open={pending !== null}
      onOpenChange={(open) => {
        if (!open) {
          pending?.answer(false)
        }
      }}
    >
      <AlertDialogContent>
        <AlertDialogHeader>
          <AlertDialogTitle>Delete {losing.join(' and ')} too?</AlertDialogTitle>
          <AlertDialogDescription>
            {[
              holdsSentence(pending?.deleted.secretStores ?? [], 'Secrets Store'),
              holdsSentence(pending?.deleted.keyStores ?? [], 'Key Store'),
              `${secretNames.length + keyNames.length === 1 ? 'It is' : 'They are'} deleted with ${oneStore ? 'the store' : 'the stores'} and cannot be recovered, not even by undoing the deletion.`,
              namedSecrets.length > 0
                ? 'Nodes and Apps that still name a secret stop working at their next run or deploy; a container already running keeps the value it started with until then.'
                : null,
              namedKeys.length > 0 ? 'Nodes that still use a key fail at their next SSH connection.' : null,
            ]
              .filter((sentence) => sentence !== null)
              .join(' ')}
          </AlertDialogDescription>
        </AlertDialogHeader>
        {namedSecrets.length > 0 ? <SecretReferenceList named={namedSecrets} /> : null}
        {namedKeys.length > 0 ? <SecretReferenceList named={namedKeys} /> : null}
        <AlertDialogFooter>
          <AlertDialogCancel>Cancel</AlertDialogCancel>
          {anyNamed ? (
            <AlertDialogAction variant='destructive' onClick={() => pending?.answer(true)}>
              Delete anyway
            </AlertDialogAction>
          ) : (
            <AlertDialogAction onClick={() => pending?.answer(true)}>Delete</AlertDialogAction>
          )}
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  )

  return { onBeforeDelete, dialog }
}

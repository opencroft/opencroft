'use client'

import { type DefaultAccess, type PermissionValue, skillKey, toolKey } from 'agent-client/permissions'
import { Plus, Save, Trash } from 'lucide-react'
import { useEffect, useState } from 'react'
import { toast } from 'sonner'
import { SegmentedButton } from 'ui/components/experimental/segmented-button'
import { Button } from 'ui/components/ui/button'
import { Field, FieldLabel } from 'ui/components/ui/field'
import { Input } from 'ui/components/ui/input'
import { Flex } from 'ui/components/ui/layout/flex'
import { MenuLayout } from 'ui/components/ui/layout/menulayout'
import { ScrollContent, ScrollHeader, ScrollPage } from 'ui/components/ui/layout/scrollpage'
import { SidebarMenuButton } from 'ui/components/ui/sidebar'

import type { RoleRecord } from './server/runtime'

export type { RoleRecord }

type AccessChoice = 'none' | PermissionValue

// Compact labels for the segmented switch.
const ACCESS_OPTIONS: { value: AccessChoice; label: string }[] = [
  { value: 'none', label: 'Off' },
  { value: 'Allow', label: 'Allow' },
  { value: 'AlwaysAllow', label: 'Always' },
]

const DEFAULT_ACCESS_OPTIONS: { value: DefaultAccess; label: string }[] = [
  { value: 'None', label: 'Off' },
  { value: 'Allow', label: 'Allow' },
  { value: 'AlwaysAllow', label: 'Always' },
]

export interface RolesManagerProps {
  // The current roles (the host loads this, e.g. via getAgentRoles()).
  roles: RoleRecord[]
  // The local tools and skills that permissions can be granted over.
  tools: { name: string; description: string }[]
  skills: { name: string; description?: string }[]
  // The global default access, applied when a session has no roles in effect.
  defaultAccess: DefaultAccess
  onCreate: (input: { name: string }) => Promise<RoleRecord>
  onUpdate: (
    id: string,
    updates: {
      name?: string
      description?: string
      permissions?: Record<string, PermissionValue>
    },
  ) => Promise<RoleRecord | null>
  onDelete: (id: string) => Promise<boolean>
  onDefaultAccessChange: (access: DefaultAccess) => Promise<void> | void
}

// One permission row: a tool/skill label + a tri-state access select.
function PermissionRow({
  label,
  value,
  onChange,
}: {
  label: string
  value: AccessChoice
  onChange: (value: AccessChoice) => void
}) {
  return (
    <Flex row align='center' className='gap-2'>
      <span className='flex-1 truncate text-sm' title={label}>
        {label}
      </span>
      <SegmentedButton size='sm' value={value} onChange={onChange} options={ACCESS_OPTIONS} />
    </Flex>
  )
}

// A two-pane manager for agent roles: a list on the left (with the global
// default-access control), a name/description form + a tool/skill permission
// matrix on the right. Data-driven — the host supplies the data and callbacks.
export function RolesManager({
  roles: incoming,
  tools,
  skills,
  defaultAccess: incomingDefault,
  onCreate,
  onUpdate,
  onDelete,
  onDefaultAccessChange,
}: RolesManagerProps) {
  const [roles, setRoles] = useState<RoleRecord[]>(incoming)
  const [selected, setSelected] = useState<RoleRecord | null>(null)
  const [name, setName] = useState('')
  const [description, setDescription] = useState('')
  const [permissions, setPermissions] = useState<Record<string, PermissionValue>>({})
  const [defaultAccess, setDefaultAccess] = useState<DefaultAccess>(incomingDefault)
  const [newName, setNewName] = useState('')

  useEffect(() => {
    setRoles(incoming)
    setSelected((current) => current ?? incoming[0] ?? null)
  }, [incoming])

  useEffect(() => setDefaultAccess(incomingDefault), [incomingDefault])

  // Mirror the selected role into the editable fields.
  useEffect(() => {
    if (!selected) return
    setName(selected.name)
    setDescription(selected.description)
    setPermissions({ ...selected.permissions })
  }, [selected])

  function setAccess(key: string, choice: AccessChoice) {
    setPermissions((prev) => {
      const next = { ...prev }
      if (choice === 'none') {
        delete next[key]
      } else {
        next[key] = choice
      }
      return next
    })
  }

  async function handleSave() {
    if (!selected) return
    const result = await onUpdate(selected.id, {
      name: name.trim() || selected.name,
      description,
      permissions,
    })
    if (result) {
      setSelected(result)
      setRoles((prev) => prev.map((r) => (r.id === result.id ? result : r)))
      toast.success('Role saved', { description: `Saved "${result.name}"` })
    } else {
      toast.error('Save failed', { description: 'That name may already be in use.' })
    }
  }

  async function handleDelete() {
    if (!selected) return
    if (await onDelete(selected.id)) {
      const remaining = roles.filter((r) => r.id !== selected.id)
      setRoles(remaining)
      setSelected(remaining[0] ?? null)
      toast.success('Role deleted')
    } else {
      toast.error('Delete failed')
    }
  }

  async function handleAdd() {
    const trimmed = newName.trim()
    if (!trimmed) return
    const role = await onCreate({ name: trimmed })
    setRoles((prev) => [...prev, role])
    setSelected(role)
    setNewName('')
    toast.success('Role created', { description: `Created "${trimmed}"` })
  }

  async function handleDefaultAccess(access: DefaultAccess) {
    setDefaultAccess(access)
    await onDefaultAccessChange(access)
    toast.success('Default access updated')
  }

  return (
    <MenuLayout
      isOpened={!!selected}
      onClosed={() => setSelected(null)}
      menuFooter={
        <>
          <Input
            value={newName}
            onChange={(e) => setNewName(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter') handleAdd()
            }}
            placeholder='Role name...'
            className='flex-1'
          />
          <Button size='icon' onClick={handleAdd} disabled={!newName.trim()}>
            <Plus className='h-4 w-4' />
          </Button>
        </>
      }
      menu={
        <Flex className='gap-1 p-1'>
          <Field className='px-1 pb-2'>
            <FieldLabel>Default access (no roles)</FieldLabel>
            <SegmentedButton
              size='sm'
              value={defaultAccess}
              onChange={handleDefaultAccess}
              options={DEFAULT_ACCESS_OPTIONS}
            />
          </Field>
          {roles.map((role) => (
            <SidebarMenuButton key={role.id} isActive={selected?.id === role.id} onClick={() => setSelected(role)}>
              {role.name}
            </SidebarMenuButton>
          ))}
        </Flex>
      }
    >
      {selected ? (
        <ScrollPage>
          <ScrollHeader>
            <Input
              value={name}
              onChange={(e) => setName(e.target.value)}
              placeholder='Role name'
              className='flex-1 border-0 bg-transparent px-0 text-2xl font-semibold shadow-none focus-visible:ring-0 md:text-2xl'
            />
            <Button onClick={handleSave}>
              <Save className='h-4 w-4' />
              Save
            </Button>
            <Button onClick={handleDelete} variant='destructive'>
              <Trash className='h-4 w-4' />
              Delete
            </Button>
          </ScrollHeader>
          <ScrollContent className='p-3 gap-4'>
            <Field>
              <FieldLabel>Description</FieldLabel>
              <Input
                value={description}
                onChange={(e) => setDescription(e.target.value)}
                placeholder='What this role is for'
              />
            </Field>
            <Field>
              <FieldLabel>Tools</FieldLabel>
              <Flex className='gap-1.5'>
                {tools.length === 0 && <span className='text-sm text-muted-foreground'>No tools available.</span>}
                {tools.map((t) => (
                  <PermissionRow
                    key={t.name}
                    label={t.name}
                    value={permissions[toolKey(t.name)] ?? 'none'}
                    onChange={(choice) => setAccess(toolKey(t.name), choice)}
                  />
                ))}
              </Flex>
            </Field>
            <Field>
              <FieldLabel>Skills</FieldLabel>
              <Flex className='gap-1.5'>
                {skills.length === 0 && <span className='text-sm text-muted-foreground'>No skills available.</span>}
                {skills.map((s) => (
                  <PermissionRow
                    key={s.name}
                    label={s.name}
                    value={permissions[skillKey(s.name)] ?? 'none'}
                    onChange={(choice) => setAccess(skillKey(s.name), choice)}
                  />
                ))}
              </Flex>
            </Field>
          </ScrollContent>
        </ScrollPage>
      ) : (
        <div className='flex-1 flex items-center justify-center font-medium'>Select a role to edit</div>
      )}
    </MenuLayout>
  )
}

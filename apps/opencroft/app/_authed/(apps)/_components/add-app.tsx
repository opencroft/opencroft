'use client'

import type { AppDefinition } from '@opencroft/client'
import { useRouter } from '@tanstack/react-router'
import { useState } from 'react'
import { Button } from 'ui/button'
import { Input } from 'ui/input'
import { Label } from 'ui/label'
import { Flex } from 'ui/layout/flex'

import { addSpaceApp } from '@/app/_authed/(apps)/_server/actions'
import type { AppMeta } from '@/app/_authed/(apps)/_server/types'
import { loadAllExtensions } from '@/app/_authed/(extension-runtime)/_client/loader'
import { useProvided } from '@/app/_authed/(extension-runtime)/_client/provides'
import { resolveIcon } from '@/app/_authed/(extension-runtime)/_client/registry'
import { instanceSlugFor } from '@/app/_authed/(space)/_server/slug'

interface Props {
  spaceSlug: string
  /** The App being added — picked in the settings' Add tab. */
  app: AppMeta
}

/**
 * The add-app form page: the required name, the App's parameters (its own
 * form when the extension ships one), and a live preview of the address the
 * name will mint. A successful add lands back on the space settings' Apps
 * section.
 */
export function AddApp({ spaceSlug, app }: Props) {
  const router = useRouter()
  const [name, setName] = useState('')
  const [values, setValues] = useState<Record<string, string>>({})
  const [error, setError] = useState<string>()
  const [saving, setSaving] = useState(false)
  // The extensions' client halves, for Apps that ship a custom parameter
  // form. Matched by type, as the App's component is.
  const { items: definitions } = useProvided<AppDefinition>('apps', loadAllExtensions)
  const CustomForm = definitions.find((d) => d.type === app.type)?.form
  const Icon = resolveIcon(app.icon)
  const previewSlug = name.trim() ? instanceSlugFor(name) : '…'

  const backToApps = () =>
    router.navigate({ to: '/space/$slug/settings', params: { slug: spaceSlug }, search: { section: 'apps' } })

  async function handleAdd() {
    if (saving) {
      return
    }
    const trimmed = name.trim()
    if (!trimmed) {
      setError('Every app needs a name.')
      return
    }
    setSaving(true)
    try {
      await addSpaceApp({
        data: { spaceSlug, type: app.type, name: trimmed, params: values },
      })
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
      return
    } finally {
      setSaving(false)
    }
    await backToApps()
    router.invalidate()
  }

  return (
    <Flex withGaps className='w-full gap-6'>
      <Flex row withGaps align='center' className='w-full'>
        <Icon className='size-5 shrink-0 text-muted-foreground' />
        <Flex className='min-w-0 flex-1'>
          <span className='font-medium'>{app.title}</span>
          {app.description && <span className='text-xs text-muted-foreground'>{app.description}</span>}
        </Flex>
      </Flex>

      <Flex withGaps className='w-full max-w-md'>
        <Label htmlFor='app-instance-name'>Name *</Label>
        <Input
          id='app-instance-name'
          autoFocus
          value={name}
          onChange={(e) => {
            setName(e.target.value)
            setError(undefined)
          }}
        />
      </Flex>

      {CustomForm ? (
        <CustomForm
          spaceSlug={spaceSlug}
          params={values}
          onChange={(next) => {
            setValues(next)
            setError(undefined)
          }}
        />
      ) : (
        (app.parameters ?? []).length > 0 && (
          <Flex withGaps className='w-full max-w-md'>
            {(app.parameters ?? []).map((spec) => (
              <Flex key={spec.id} withGaps className='w-full'>
                <Label htmlFor={`app-param-${spec.id}`}>
                  {spec.label}
                  {spec.required ? ' *' : ''}
                </Label>
                <Input
                  id={`app-param-${spec.id}`}
                  value={values[spec.id] ?? ''}
                  placeholder={spec.placeholder}
                  onChange={(e) => {
                    setValues((prev) => ({ ...prev, [spec.id]: e.target.value }))
                    setError(undefined)
                  }}
                />
                {spec.description && <p className='text-xs text-muted-foreground'>{spec.description}</p>}
              </Flex>
            ))}
          </Flex>
        )
      )}

      {/* The instance's address, minted from the typed name once at
          creation — a live preview of it. */}
      <p className='text-xs text-muted-foreground'>
        Address: {spaceSlug}.{previewSlug}
      </p>
      {error && <p className='text-sm text-destructive'>{error}</p>}
      <Flex row withGaps>
        <Button variant='ghost' onClick={() => void backToApps()}>
          Cancel
        </Button>
        <Button onClick={handleAdd} disabled={saving || !name.trim()}>
          {saving ? 'Adding…' : 'Add'}
        </Button>
      </Flex>
    </Flex>
  )
}

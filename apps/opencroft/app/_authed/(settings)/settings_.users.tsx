import { createFileRoute, useNavigate } from '@tanstack/react-router'
import { AdminUsers } from 'ui/admin/admin-users'
import { ScrollContent, ScrollPage } from 'ui/layout/scrollpage'

import { roleLabel } from '@/app/_authed/(settings)/_lib/roles'
import { getSingleAdminWarning, listUsers } from '@/app/_authed/(settings)/_server/admin-users-actions'

export const Route = createFileRoute('/_authed/(settings)/settings_/users')({
  loader: async () => {
    const [users, singleAdmin] = await Promise.all([listUsers(), getSingleAdminWarning()])
    return { users, singleAdmin }
  },
  component: UsersSettingsPage,
})

function formatDate(value: string | Date | null): string | undefined {
  if (!value) {
    return undefined
  }
  return new Date(value).toISOString().slice(0, 10)
}

function UsersSettingsPage() {
  const { users, singleAdmin } = Route.useLoaderData()
  const navigate = useNavigate()

  return (
    <ScrollPage>
      <ScrollContent className='p-4'>
        <div className='mx-auto flex w-full max-w-3xl flex-col gap-4'>
          {singleAdmin ? (
            // The state this check exists to make visible instead of
            // silent: exactly one administrator, no recovery if that
            // password is lost. See RECOVERY.md for the break-glass
            // procedure — this banner is the thing that should send someone
            // there before they need it.
            <div className='rounded-lg border border-amber-500/30 bg-amber-500/10 p-3 text-sm'>
              This instance has only one administrator. If that account's password is lost, there is no self-service
              recovery — add a second administrator so you are not the single point of failure.
            </div>
          ) : null}
          <AdminUsers
            users={users.map((user) => ({
              id: user.id,
              name: user.name,
              email: user.email,
              avatar: user.image,
              role: roleLabel(user.role),
              joinedAt: formatDate(user.createdAt) ?? '',
              lastSeenAt: formatDate(user.lastSeenAt),
              disabled: user.disabled,
            }))}
            onAdd={() => navigate({ to: '/settings/users/new' })}
            onEdit={(userId) => navigate({ to: '/settings/users/$userId', params: { userId } })}
          />
        </div>
      </ScrollContent>
    </ScrollPage>
  )
}

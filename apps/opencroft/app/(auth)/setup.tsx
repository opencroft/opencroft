import { createFileRoute, redirect } from '@tanstack/react-router'

import { SetupPage } from '@/app/(auth)/_components/setup-page'
import { getSetupStatus } from '@/app/(auth)/_server/setup'

// Reachable only while the instance has no accounts. Once one exists this
// route stops existing as far as a visitor is concerned — checked in
// beforeLoad, so the answer comes from the database rather than from anything
// the browser could arrange, and the screen never renders when it shouldn't.
//
// The write is refused independently in createFirstAdmin: this redirect is for
// people who wander here, not the thing keeping the route safe.
//
// ASSUMPTION THIS DESIGN RESTS ON: while the user table is empty, whoever
// reaches the instance first becomes its administrator. This route cannot
// authenticate the person claiming it — there is nothing to authenticate
// against yet — so the only thing making that acceptable is that the
// deployment sits behind the reverse proxy's basic auth, which decides who can
// reach the instance at all. A deployment that exposes this app directly must
// complete setup before it is reachable, or the first stranger to find it owns
// it. See the boundary comment in __root.tsx for the same dependency as it
// applies to the API surfaces.
export const Route = createFileRoute('/(auth)/setup')({
  beforeLoad: async () => {
    const { needsSetup } = await getSetupStatus()
    if (!needsSetup) {
      throw redirect({ to: '/' })
    }
  },
  component: SetupPage,
})

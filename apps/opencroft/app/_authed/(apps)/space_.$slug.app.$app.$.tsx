import { createFileRoute } from '@tanstack/react-router'

// Everything under an App instance's address is the App's own path, which the
// App reads and matches itself (see app-router). The App page above draws the
// App; this route only lets those paths reach it. Being a child is what keeps
// the page's loader from re-running as the App moves between its pages: only
// this match changes, and it loads nothing.
export const Route = createFileRoute('/_authed/(apps)/space_/$slug/app/$app/$')({})

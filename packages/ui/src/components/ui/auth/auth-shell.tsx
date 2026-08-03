import type { ReactNode } from 'react'

export interface AuthShellProps {
  children: ReactNode
}

// The centred page frame every auth screen sits in: full height, centred both
// ways, padded, and a fixed-width column so whatever it holds reads at a
// consistent measure regardless of viewport. Transferred as-is -- brand and
// footer are deliberately not part of it; a host places those around what it
// puts inside.
export function AuthShell({ children }: AuthShellProps) {
  return (
    <div className='flex min-h-svh flex-col items-center justify-center gap-6 bg-background p-6 md:p-10'>
      <div className='w-full max-w-sm'>
        <div className='flex flex-col gap-6'>{children}</div>
      </div>
    </div>
  )
}

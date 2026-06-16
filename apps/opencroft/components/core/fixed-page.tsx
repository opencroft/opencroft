'use client'

export function FixedPage({
  children,
  header,
  footer,
}: {
  children: React.ReactNode
  header?: React.ReactNode
  footer?: React.ReactNode
}) {
  return (
    <div className='flex-1 flex flex-col'>
      {header ? header : ''}
      <div className='flex-1 flex'>{children}</div>
      {footer ? footer : ''}
    </div>
  )
}

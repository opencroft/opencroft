'use client';

interface IFrameProps {
  url?: string;
  port?: number;
  title: string;
}

export default function IFrame({ url, port, title }: IFrameProps) {
  const src = url || (port && typeof window !== 'undefined' ? `${window.location.protocol}//${window.location.hostname}:${port}` : '');

  return (
    <div className='h-full w-full'>
      <iframe
        src={src}
        width='100%'
        height='100%'
        className='border-0'
        title={title}
        allow="clipboard-read; clipboard-write"
      />
    </div>
  );
}

export function createIFrameRoute(title: string, port: number) {
  const Component = () => <IFrame title={title} port={port} />;
  Component.displayName = `IFrameRoute(${title})`;
  return Component;
}

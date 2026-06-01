export interface CardProps {
  children?: React.ReactNode;
  imageSrc?: string;
  onClick?(): void;
}

export function Card({ children, imageSrc, onClick }: CardProps) {
  return (
    <div className='relative w-full aspect-[2/3] bg-muted rounded-lg overflow-hidden cursor-pointer hover:shadow-lg transition-shadow group' onClick={onClick}>
      {imageSrc && (
        <img
          src={imageSrc}
          alt=""
          className='object-cover'
          style={{ position: 'absolute', inset: 0, width: '100%', height: '100%', objectFit: 'cover' }}
        />
      )}

      {/* Title overlay at bottom with semitransparent background */}
      <div className='absolute bottom-0 left-0 right-0 bg-background/80 text-foreground p-2'>
        <div className='text-sm font-medium'>{children}</div>
      </div>
    </div>
  );
}

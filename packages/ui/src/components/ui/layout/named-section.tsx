import React from 'react';

export interface NamedSectionProps {
  title?: string;
  menu?: React.ReactNode;
  children: React.ReactNode;
}

export function NamedSection({ title, menu, children }: NamedSectionProps) {
  return (
    <div className="relative border-2 border-dashed border-muted-foreground/30 rounded-lg mt-4">
      <div className="absolute -top-4 left-4 right-4 flex items-center justify-between gap-4">
        <h3 className="font-medium bg-background px-2 text-foreground">
          {title}
        </h3>
        {menu && (
          <div className="bg-background px-1">
            {menu}
          </div>
        )}
      </div>
      <div className="p-2 pt-4">
        {children}
      </div>
    </div>
  );
}

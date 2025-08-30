'use client';

import Image from 'next/image';
import React from 'react';

import { ContextMenu, ContextMenuContent, ContextMenuItem, ContextMenuTrigger } from '@/components/ui/context-menu';


interface ThumbnailCardProps {
  key: string;
  name: string;
  imageSrc: string;
  imageKey?: number;
  isSelected?: boolean;
  onClick: () => void;
  onEdit: () => void;
  onDelete: () => void;
}

export const ThumbnailCard = React.memo(function ThumbnailCard({
  name,
  imageSrc,
  imageKey,
  isSelected = false,
  onClick,
  onEdit,
  onDelete
}: ThumbnailCardProps) {

  return (
    <ContextMenu>
      <ContextMenuTrigger asChild>
        <div
          className={`relative bg-muted rounded-lg overflow-hidden cursor-pointer transition-all aspect-[2/3] ${
            isSelected ? 'ring-4 ring-primary' : 'hover:shadow-lg'
          }`}
          onClick={onClick}
        >
          <Image
            src={`${imageSrc}?t=${imageKey || 0}`}
            alt={`${name} thumbnail`}
            fill
            className="object-cover"
            unoptimized
          />
          <div className="absolute bottom-0 left-0 right-0 bg-background/50 text-foreground p-2 text-shadow-xs text-shadow-accent">
            <div className="text-sm font-medium truncate">{name}</div>
          </div>
        </div>
      </ContextMenuTrigger>
      <ContextMenuContent>
        <ContextMenuItem onClick={onEdit}>
          Edit
        </ContextMenuItem>
        <ContextMenuItem onClick={onDelete} className="text-destructive">
          Delete
        </ContextMenuItem>
      </ContextMenuContent>
    </ContextMenu>
  );
});

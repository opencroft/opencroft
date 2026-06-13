'use client'

import { useState } from 'react'

import { useVideoLoop } from '@/components/hooks/use-video-loop'
import { cn } from '@/lib/utils'

export interface VideoLoopProps {
  videos: string[]
  repeatCount?: number
  className?: string
  showDebug?: boolean
  enableVolumeWithMouseHover?: boolean
  playsInline?: boolean
}

export function VideoLoop({
  videos,
  repeatCount = 2,
  className,
  showDebug = false,
  enableVolumeWithMouseHover = false,
  playsInline = true,
}: VideoLoopProps) {
  const { videoRef, currentIndex, currentRepeat } = useVideoLoop(videos, repeatCount)
  const [isHovered, setIsHovered] = useState(false)

  return (
    <div className='w-full h-full flex relative items-center justify-center'>
      <video
        ref={videoRef}
        className={cn('rounded-lg shadow-lg max-h-full max-w-full', className)}
        autoPlay
        playsInline={playsInline}
        muted={enableVolumeWithMouseHover ? !isHovered : true}
        onMouseEnter={() => enableVolumeWithMouseHover && setIsHovered(true)}
        onMouseLeave={() => enableVolumeWithMouseHover && setIsHovered(false)}
      />
      {showDebug && (
        <>
          <div className='absolute bottom-0 left-0 right-0 bg-black/70 text-white text-sm'>
            <p>
              {currentRepeat + 1} / {repeatCount}
            </p>
          </div>
          <div className='absolute top-0 left-0 right-0 bg-black/70 text-white text-sm'>
            <div className='space-y-1'>
              {videos.map((video, i) => (
                <a
                  key={i}
                  href={video}
                  target='_blank'
                  rel='noopener noreferrer'
                  className={cn(
                    'block text-xs hover:underline truncate',
                    i !== currentIndex ? 'text-muted-foreground' : '',
                  )}
                >
                  {video}
                </a>
              ))}
            </div>
          </div>
        </>
      )}
    </div>
  )
}

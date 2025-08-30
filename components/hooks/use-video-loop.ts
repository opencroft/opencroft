import { useEffect, useRef, useState } from 'react';

import { useFadeElement } from '@/components/hooks/use-fade-element';

export function useVideoLoop(videos: string[], repeatCount: number) {
  const [index, setIndex] = useState(0);
  const [repeat, setRepeat] = useState(0);
  const videoRef = useRef<HTMLVideoElement>(null);

  const onTransitionComplete = async ()=>{
    const video = videoRef.current;
    if (!video) {
      return;
    }

    video.src = videos[index];
    video.load();
    await video.play();
  };

  const { fadeTransition } = useFadeElement(videoRef, 300, onTransitionComplete);

  useEffect(() => {
    const video = videoRef.current;
    if (!video) {
      return;
    }

    const onEnded = () => {
      video.play();
      if (repeat + 1 < repeatCount) {
        setRepeat(repeat + 1);
        video.currentTime = 0;
      } else {
        setIndex((index + 1) % videos.length);
        setRepeat(0);
      }
    };

    video.addEventListener('ended', onEnded);

    return () => {
      video.removeEventListener('ended', onEnded);
    };
  }, [index, repeat, repeatCount, videos.length]);

  useEffect(() => {
    fadeTransition();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [index, videos]); // Adding fadeTransition dependency breaks playback

  return {
    videoRef,
    currentIndex: index,
    currentRepeat: repeat,
    currentVideo: videos[index],
  };
}

'use client';

import { useRouter } from "next/navigation";
import { useCallback } from "react";

import { MenuLayout, MenuLayoutProps } from "@/components/ui/layout/menulayout";

interface RoutedMenuLayoutProps extends Omit<MenuLayoutProps, 'isOpened' | 'onClosed'> {
  path: string,
  slug?: string,
}

export function RoutedMenuLayout(props: RoutedMenuLayoutProps) {
  const router = useRouter();
  const onClosed = useCallback(() => router.replace(props.path), [router, props.path]);

  return <MenuLayout
    isOpened={!!props.slug}
    onClosed={onClosed}
    {...props}
  />;
}

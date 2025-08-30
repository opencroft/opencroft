import type { Metadata } from "next";
import { Geist, Geist_Mono } from "next/font/google";

import { SSEProvider } from "@/app/(sse)/components/sse-provider";
import { AppLayout } from "@/app/app-layout";
import "@/app/globals.css";
import { Toaster } from "@/components/ui/sonner";
import { ThemeProvider } from "@/components/ui/theme-provider";

const geistSans = Geist({
  variable: "--font-geist-sans",
  subsets: ["latin"],
});

const geistMono = Geist_Mono({
  variable: "--font-geist-mono",
  subsets: ["latin"],
});

export const metadata: Metadata = {
  title: "OpenCroft",
  description: "Platform for your home lab",
};

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <html lang="en" suppressHydrationWarning>
      <body
        className={`${geistSans.variable} ${geistMono.variable} antialiased`}
      >
        <ThemeProvider
          attribute="class"
          defaultTheme="system"
          enableSystem
        >
          <SSEProvider>
            <AppLayout>
              {children}
            </AppLayout>
          </SSEProvider>
          <Toaster
            position="top-center"
            richColors
          />
        </ThemeProvider>
      </body>
    </html>
  );
}

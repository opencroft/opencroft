import type { NextConfig } from 'next';

const nextConfig: NextConfig = {
  images: {
    remotePatterns: [
      {
        protocol: 'https',
        hostname: 'www.gravatar.com',
        pathname: '/avatar/**',
      },
    ],
  },
  devIndicators: false,
  serverExternalPackages: ['ssh2', 'ws', 'esbuild'],
  experimental: {
    serverActions: {
      allowedOrigins: [
        ...(process.env.ALLOWED_ORIGINS?.split(',').map(s => s.trim()).filter(Boolean) ?? []),
        'localhost:3000',
        'localhost:9999',
      ],
    },
  },
  output: 'standalone',
  typescript: {
    ignoreBuildErrors: true,
  },
};

export default nextConfig;

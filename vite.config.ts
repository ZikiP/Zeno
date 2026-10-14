import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import { VitePWA } from 'vite-plugin-pwa';
import { fileURLToPath, URL } from 'node:url';

export default defineConfig({
  plugins: [
    react(),
    VitePWA({
      registerType: 'autoUpdate',
      includeAssets: [],
      manifest: {
        name: '漫画阅读器',
        short_name: '漫画',
        description: '跨端漫画阅读器，无广告阅读体验',
        theme_color: '#111827',
        background_color: '#111827',
        display: 'standalone',
        orientation: 'any',
        start_url: '/',
        icons: [
          { src: 'icon-192.png', sizes: '192x192', type: 'image/png' },
          { src: 'icon-512.png', sizes: '512x512', type: 'image/png' },
          { src: 'icon-512.png', sizes: '512x512', type: 'image/png', purpose: 'maskable' },
        ],
      },
      workbox: {
        globPatterns: ['**/*.{js,css,html,png,svg,ico}'],
        runtimeCaching: [
          {
            // 漫画图片：缓存优先，断网可读
            urlPattern: /^https:\/\/[^/]*bzcdn\.net\/.*\.(jpg|jpeg|png|webp)$/i,
            handler: 'CacheFirst',
            options: {
              cacheName: 'comic-images',
              expiration: { maxEntries: 800, maxAgeSeconds: 60 * 60 * 24 * 90 },
              cacheableResponse: { statuses: [0, 200] },
            },
          },
          {
            // 封面图
            urlPattern: /^https:\/\/[^/]*(baozimh|xgcartoon|ttkan)[^/]*\/cover\/.*/i,
            handler: 'CacheFirst',
            options: {
              cacheName: 'comic-covers',
              expiration: { maxEntries: 300, maxAgeSeconds: 60 * 60 * 24 * 30 },
              cacheableResponse: { statuses: [0, 200] },
            },
          },
          {
            // 站点页面：网络优先，拿到最新的章节信息
            urlPattern: /^https:\/\/[^/]*(twmanga|twbzmg|baozimh)\.[^/]+\/.*/i,
            handler: 'NetworkFirst',
            options: {
              cacheName: 'site-pages',
              networkTimeoutSeconds: 8,
              expiration: { maxEntries: 100, maxAgeSeconds: 60 * 60 * 24 * 7 },
              cacheableResponse: { statuses: [0, 200] },
            },
          },
        ],
      },
      devOptions: { enabled: false },
    }),
  ],
  resolve: {
    alias: { '@': fileURLToPath(new URL('./src', import.meta.url)) },
  },
  server: {
    host: '0.0.0.0',
    port: 5178,
    // 开发时的 CORS 代理 —— 生产部署时由 server/proxy.mjs 接管同一路径
    proxy: {
      '/api': {
        target: 'http://127.0.0.1:8788',
        changeOrigin: true,
      },
    },
  },
  preview: {
    host: '0.0.0.0',
    port: 4178,
  },
});

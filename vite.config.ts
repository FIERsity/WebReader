import { defineConfig } from "vitest/config";
import { resolve } from "node:path";
import react from "@vitejs/plugin-react";
import { VitePWA } from "vite-plugin-pwa";
import { deepSeekProxyPlugin } from "./dev/deepseekProxy.js";

export default defineConfig({
  base: "./",
  build: {
    rollupOptions: {
      input: {
        index: resolve(import.meta.dirname, "index.html"),
        translator: resolve(import.meta.dirname, "translator.html"),
      },
    },
  },
  plugins: [
    deepSeekProxyPlugin(),
    react(),
    VitePWA({
      registerType: "prompt",
      includeAssets: ["icons/icon.svg"],
      manifest: {
        name: "WebReader",
        short_name: "WebReader",
        description: "一款默认保护隐私、支持本地 EPUB、PDF 和文本文件的双语阅读器。",
        lang: "zh-CN",
        theme_color: "#176b57",
        background_color: "#f7f8f5",
        display: "standalone",
        start_url: "./",
        scope: "./",
        icons: [
          { src: "icons/icon.svg", sizes: "any", type: "image/svg+xml", purpose: "any maskable" },
        ],
      },
      workbox: {
        navigateFallback: "index.html",
        globPatterns: ["**/*.{js,mjs,css,html,svg,woff2}"],
        cleanupOutdatedCaches: true,
        runtimeCaching: [],
      },
    }),
  ],
  test: {
    environment: "node",
    include: ["src/**/*.test.ts", "dev/**/*.test.ts"],
  },
});

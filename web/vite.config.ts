import { execSync } from 'node:child_process'
import { fileURLToPath, URL } from 'node:url'

import tailwindcss from '@tailwindcss/vite'
import react from '@vitejs/plugin-react'
import { defineConfig } from 'vite'

/**
 * 页脚版本号：`git describe --tags --always --dirty`（WorkerHub 通用方案要求展示 git 版本）。
 * 构建期注入，运行期不再读 git；非 git 环境（如打包源码副本）回落到 `dev`。
 */
function gitVersion(): string {
  try {
    return execSync('git describe --tags --always --dirty', {
      stdio: ['ignore', 'pipe', 'ignore'],
    })
      .toString()
      .trim()
  } catch {
    return 'dev'
  }
}

export default defineConfig({
  plugins: [react(), tailwindcss()],
  resolve: {
    alias: { '@': fileURLToPath(new URL('./src', import.meta.url)) },
  },
  define: {
    __APP_VERSION__: JSON.stringify(gitVersion()),
  },
  build: {
    outDir: 'dist',
    // Worker 用 [assets] 直接托管这份产物（wrangler.jsonc 的 directory 指向它）。
    emptyOutDir: true,
    sourcemap: false,
    // 管理面是内部工具：按依赖域拆 chunk 提升缓存命中，首页 JS 不至于单包过大。
    rollupOptions: {
      output: {
        manualChunks: {
          react: ['react', 'react-dom', 'react-router-dom'],
          data: ['@tanstack/react-query', 'zustand'],
          forms: ['react-hook-form', 'zod', '@hookform/resolvers'],
          // 第二因素的浏览器端依赖（WebAuthn 交互 + 二维码）单独成块：
          // 只在登录第二步 / 设置安全区用到，不跟首屏管理面挤在一个 chunk 里。
          auth: ['@simplewebauthn/browser', 'qrcode'],
        },
      },
    },
  },
  server: {
    port: 5173,
    // 本地开发：前端热更新 + 后端仍是真 workerd（`pnpm dev` → wrangler dev 8787）。
    proxy: {
      '/api': 'http://127.0.0.1:8787',
      '/v1': 'http://127.0.0.1:8787',
      '/healthz': 'http://127.0.0.1:8787',
    },
  },
})

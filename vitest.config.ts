import { defineConfig } from 'vitest/config'

export default defineConfig({
  test: {
    environment: 'node',
    include: ['tests/**/*.test.ts'],
    // 集成测试在真 workerd 里跑（真 DO + 真 SQLite + 真 Queue 消费），
    // 冷启动与队列异步投递都需要比纯单测更宽的时间。
    testTimeout: 30_000,
    hookTimeout: 60_000,
  },
})

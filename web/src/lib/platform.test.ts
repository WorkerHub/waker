import { describe, expect, it } from 'vitest'

import { getPlatformDomain } from '@/lib/platform'

/** 平台域名是运行时事实：跟着当前访问地址走，不写死任何域名。 */
describe('getPlatformDomain', () => {
  it('返回当前访问域名（含端口）', () => {
    expect(getPlatformDomain()).toBe(window.location.host)
    // jsdom 默认地址是 http://localhost:3000/ —— 带端口时如实显示
    expect(getPlatformDomain()).toBe('localhost:3000')
  })
})

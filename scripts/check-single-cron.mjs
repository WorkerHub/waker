#!/usr/bin/env node
/**
 * 硬约束守卫：全仓只允许 1 个 Cron Trigger（watchdog），且不得出现 D1 / KV 绑定。
 *
 * 用法：node scripts/check-single-cron.mjs
 * 退出码：0 合规；1 违规（CI 失败关闭）。
 */
import { execFileSync } from 'node:child_process'
import { readFileSync } from 'node:fs'

/** 本文件自身含有匹配模式，扫描时排除。 */
const SELF = 'scripts/check-single-cron.mjs'
const CRON_ASSIGN = /\bcrons\s*=/
const WATCHDOG_CRON = '0 * * * *'

const files = execFileSync('git', ['ls-files', '-z'], { encoding: 'utf8' })
  .split('\0')
  .filter((file) => file.length > 0 && file !== SELF)

const cronHits = []
const storageHits = []

for (const file of files) {
  let text
  try {
    text = readFileSync(file, 'utf8')
  } catch {
    continue // 二进制 / 不可读文件跳过
  }
  if (text.includes('\0')) continue

  text.split('\n').forEach((line, index) => {
    if (CRON_ASSIGN.test(line)) cronHits.push({ file, line: index + 1, text: line.trim() })
  })

  if (file === 'wrangler.toml') {
    text.split('\n').forEach((line, index) => {
      if (/^\s*\[\[(d1_databases|kv_namespaces)\]\]/.test(line)) {
        storageHits.push({ file, line: index + 1, text: line.trim() })
      }
    })
  }
}

const problems = []

if (cronHits.length !== 1) {
  problems.push(
    `Cron Trigger 配置出现 ${cronHits.length} 处，必须恰好 1 处（watchdog）：\n` +
      cronHits.map((hit) => `  ${hit.file}:${hit.line}: ${hit.text}`).join('\n'),
  )
} else {
  const [hit] = cronHits
  if (hit.file !== 'wrangler.toml' || !hit.text.includes(WATCHDOG_CRON)) {
    problems.push(`唯一的 Cron Trigger 必须是 wrangler.toml 中的 watchdog（${WATCHDOG_CRON}），实际：${hit.file}:${hit.line}: ${hit.text}`)
  }
}

if (storageHits.length > 0) {
  problems.push(
    '禁止 D1 / KV 绑定（真源只有 WakerDO 的 SQLite）：\n' +
      storageHits.map((hit) => `  ${hit.file}:${hit.line}: ${hit.text}`).join('\n'),
  )
}

if (problems.length > 0) {
  for (const problem of problems) console.error(`::error::${problem}`)
  process.exit(1)
}

console.log(`OK: 全仓 Cron Trigger 恰好 1 处（watchdog ${WATCHDOG_CRON}），无 D1 / KV 绑定。`)

#!/usr/bin/env node
/**
 * 硬约束守卫（B1 定、B5 收窄示例范围，语义不变）：
 *
 *   ① **平台本体**只允许 1 个 Cron Trigger（watchdog `0 * * * *`），且必须写在平台 wrangler 配置里；
 *   ② 平台配置不得出现 D1 / KV 绑定（真源只有 WakerDO 的 SQLite）。
 *
 * `examples/**` 是**下游项目形态的参考示例**（B5 SDK 的接入演示），不是本仓的部署目标：
 * 它演示「原生模式」时，wrangler 配置里必然带 `[triggers]` —— 那正是下游项目自己的一个
 * Cron Trigger 槽，与平台本体的「只占 1 个槽」是两件事。因此示例里的命中单独统计：
 * 必须落在 `examples/**` 的 `.toml` 配置文件里、每个文件最多 1 处，且不计入平台预算。
 *
 * 用法：node scripts/check-single-cron.mjs
 * 退出码：0 合规；1 违规（CI 失败关闭）。
 */
import { execFileSync } from 'node:child_process'
import { readFileSync } from 'node:fs'

/** 本文件自身含有匹配模式，扫描时排除。 */
const SELF = 'scripts/check-single-cron.mjs'
const PLATFORM_CONFIG = 'wrangler.toml'
const EXAMPLES_PREFIX = 'examples/'
const CRON_ASSIGN = /\bcrons\s*=/
const WATCHDOG_CRON = '0 * * * *'

const files = execFileSync('git', ['ls-files', '-z'], { encoding: 'utf8' })
  .split('\0')
  .filter((file) => file.length > 0 && file !== SELF)

const platformCronHits = []
const exampleCronHits = []
const storageHits = []

for (const file of files) {
  let text
  try {
    text = readFileSync(file, 'utf8')
  } catch {
    continue // 二进制 / 不可读文件跳过
  }
  if (text.includes('\0')) continue

  const isExample = file.startsWith(EXAMPLES_PREFIX)
  text.split('\n').forEach((line, index) => {
    if (!CRON_ASSIGN.test(line)) return
    const hit = { file, line: index + 1, text: line.trim() }
    if (isExample) exampleCronHits.push(hit)
    else platformCronHits.push(hit)
  })

  if (file === PLATFORM_CONFIG) {
    text.split('\n').forEach((line, index) => {
      if (/^\s*\[\[(d1_databases|kv_namespaces)\]\]/.test(line)) {
        storageHits.push({ file, line: index + 1, text: line.trim() })
      }
    })
  }
}

const problems = []

if (platformCronHits.length !== 1) {
  problems.push(
    `平台 Cron Trigger 配置出现 ${platformCronHits.length} 处，必须恰好 1 处（watchdog）：\n` +
      platformCronHits.map((hit) => `  ${hit.file}:${hit.line}: ${hit.text}`).join('\n'),
  )
} else {
  const [hit] = platformCronHits
  if (hit.file !== PLATFORM_CONFIG || !hit.text.includes(WATCHDOG_CRON)) {
    problems.push(
      `唯一的平台 Cron Trigger 必须是 ${PLATFORM_CONFIG} 中的 watchdog（${WATCHDOG_CRON}），实际：${hit.file}:${hit.line}: ${hit.text}`,
    )
  }
}

// 示例允许带自己的 triggers，但只能出现在 examples/** 的 toml 配置里（每文件最多 1 处）：
// 扫描的是「配置文件」，不是文档片段——README 里写示例配置请指向那个文件。
const perExampleFile = new Map()
for (const hit of exampleCronHits) {
  if (!hit.file.endsWith('.toml')) {
    problems.push(`示例的 Cron 配置必须写在 examples/** 的 .toml 配置文件里，实际：${hit.file}:${hit.line}`)
  }
  perExampleFile.set(hit.file, (perExampleFile.get(hit.file) ?? 0) + 1)
}
for (const [file, count] of perExampleFile) {
  if (count > 1) problems.push(`示例配置 ${file} 里出现了 ${count} 处 Cron 配置，必须最多 1 处`)
}

if (storageHits.length > 0) {
  problems.push(
    '平台禁止 D1 / KV 绑定（真源只有 WakerDO 的 SQLite）：\n' +
      storageHits.map((hit) => `  ${hit.file}:${hit.line}: ${hit.text}`).join('\n'),
  )
}

if (problems.length > 0) {
  for (const problem of problems) console.error(`::error::${problem}`)
  process.exit(1)
}

console.log(
  `OK: 平台 Cron Trigger 恰好 1 处（watchdog ${WATCHDOG_CRON}），平台无 D1 / KV 绑定；` +
    `示例（examples/**，非本仓部署目标）另有 ${exampleCronHits.length} 处，均在配置文件内。`,
)

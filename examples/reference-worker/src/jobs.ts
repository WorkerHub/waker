import type {
  JsonValue,
  WakerJobContext,
  WakerJobResolver,
  WakerManifestJob,
} from '../../../client/src/index'

/**
 * 参考接入示例的「业务层」：**同一份任务处理逻辑，给两个入口共用**。
 *
 *   - 原生模式：`scheduled()` 收到 CF Cron Trigger → `runScheduled()` 按 cron 表达式找到任务名 → 执行；
 *   - waker 模式：平台回调 `/_waker/execute` → receiver 按 `jobName` 找到同一个 handler → 执行。
 *
 * 两条入口最终都落到 `runJob()`，业务代码不重复、不分支。
 * 声明式任务的 cron 表达式也只写一次（{@link DAILY_CLEANUP_CRON}）：原生模式的
 * `[triggers]` 与 waker 模式的注册清单都用它，**逐字相同**（B2 冻结的 CF 官方方言）。
 */

/** CF 官方 cron 方言的 5 字段表达式（`0 3 * * *` = 每天 03:00，时区取任务自己的 timezone）。 */
export const DAILY_CLEANUP_CRON = '0 3 * * *'

/** 声明式任务名（平台 / manifest / receiver 的 jobs key 用同一个字符串）。 */
export const DAILY_CLEANUP_JOB = 'daily-cleanup'

/** 一次性自续任务名前缀（运行时按业务 id 创建，如 `reminder-tick-<letterId>`）。 */
export const REMINDER_TICK_PREFIX = 'reminder-tick-'

/** 声明式清单：原生模式的 `[triggers]` 与 waker 模式的注册清单都从这里取。 */
export const referenceManifest: WakerManifestJob[] = [
  {
    name: DAILY_CLEANUP_JOB,
    cron: DAILY_CLEANUP_CRON,
    timezone: 'Asia/Shanghai',
    payload: { source: 'reference-example' },
    // 清理类任务：错过窗口就跳过（不补跑），单次执行 30s 足够。
    policies: { misfire: 'skip', timeoutSeconds: 30 },
  },
]

/** 一次业务执行的记录（示例为了可观测性存内存；真实下游写自己的库/日志）。 */
export interface JobRunRecord {
  jobName: string
  /** 入口：原生 scheduled 还是 waker 回调。 */
  source: 'scheduled' | 'waker'
  /** waker 回调的执行 id（原生模式为 null）。 */
  executionId: string | null
  scheduledFor: number
  finishedAt: number
  detail: Record<string, unknown>
}

/** `reminder-tick-*` 的载荷（一次性自续任务的业务参数）。 */
export interface ReminderTickPayload {
  /** 窗口终点（epoch ms）：推进到超过它为止，之后不再续期。 */
  renewUntil?: number
  /** 每次推进的间隔（毫秒）。 */
  intervalMs?: number
  label?: string
}

interface RunJobInput {
  jobName: string
  source: 'scheduled' | 'waker'
  executionId: string | null
  scheduledFor: number
  payload: JsonValue
  now: number
}

interface RunJobResult {
  detail: Record<string, unknown>
  /** 有值 = 自续（平台校验后以同一 job 系列续期）；无值 = 本次完结。 */
  nextRunAt?: number
}

/** 示例业务：清理过期短链（两种入口共用这一份）。 */
export async function runDailyCleanup(input: {
  scheduledFor: number
}): Promise<Record<string, unknown>> {
  return { cleanedLinks: 3, scheduledFor: input.scheduledFor }
}

/**
 * 示例业务：提醒推进 + 自续（eNotify 式「窗口内逐次推进」的最小模型）。
 *
 * 状态全在 `payload` 里（真实下游的状态在业务库里）：窗口终点 `renewUntil` 之前
 * 每 `intervalMs` 推进一次，推进到窗口外就返回空（任务完结，平台不再续期）。
 */
export async function runReminderTick(input: {
  payload: JsonValue
  now: number
}): Promise<RunJobResult> {
  const payload = (input.payload ?? {}) as ReminderTickPayload
  const intervalMs =
    typeof payload.intervalMs === 'number' && payload.intervalMs > 0 ? payload.intervalMs : 60_000
  const renewUntil = typeof payload.renewUntil === 'number' ? payload.renewUntil : input.now
  const nextRunAt = input.now + intervalMs
  const detail: Record<string, unknown> = {
    deliveredAt: input.now,
    label: typeof payload.label === 'string' ? payload.label : null,
  }

  if (nextRunAt <= renewUntil) return { detail, nextRunAt }
  return { detail: { ...detail, done: true } }
}

/** 任务名 → 业务逻辑（两个入口共用这一处分发）。 */
export async function runJob(input: RunJobInput): Promise<RunJobResult> {
  if (input.jobName === DAILY_CLEANUP_JOB) {
    return { detail: await runDailyCleanup({ scheduledFor: input.scheduledFor }) }
  }
  if (input.jobName.startsWith(REMINDER_TICK_PREFIX)) {
    return runReminderTick({ payload: input.payload, now: input.now })
  }
  throw new Error(`未知任务名：${input.jobName}`)
}

export interface ReferenceJobs {
  /**
   * receiver 的 `jobs` 解析器：one-shot 的任务名是按业务 id 动态生成的
   * （`reminder-tick-<id>`），静态 map 装不下，所以这里用「名字 → handler」的函数。
   */
  handlers: WakerJobResolver
  /** 声明式清单（部署期同步给平台）。 */
  manifest: WakerManifestJob[]
  /** 执行记录（`GET /demo/runs` 展示 / 测试断言）。 */
  runs: JobRunRecord[]
  /**
   * 原生 scheduled 入口：按 **cron 表达式逐字匹配** 找到声明式任务，再走同一份业务逻辑。
   *
   * 不按「任务名」匹配是有意的：原生模式只有 `controller.cron` 可用，
   * 所以清单里的表达式必须与 wrangler `[triggers]` 逐字一致。
   */
  runScheduled(input: { cron: string; scheduledTime: Date }): Promise<JobRunRecord>
}

/**
 * 建一个示例业务实例（内存记录，便于本地跑通与测试断言）。
 * 真实下游应把这些记录写进自己的库，其余逻辑可以原样搬。
 */
export function createReferenceJobs(): ReferenceJobs {
  const runs: JobRunRecord[] = []

  const execute = async (input: RunJobInput): Promise<RunJobRecordPair> => {
    const result = await runJob(input)
    const record: JobRunRecord = {
      jobName: input.jobName,
      source: input.source,
      executionId: input.executionId,
      scheduledFor: input.scheduledFor,
      finishedAt: input.now,
      detail: result.detail,
    }
    runs.push(record)
    return { record, result }
  }

  const wakerHandler = async (context: WakerJobContext) => {
    const { result } = await execute({
      jobName: context.jobName,
      source: 'waker',
      executionId: context.executionId,
      scheduledFor: context.scheduledFor,
      payload: context.payload,
      now: Date.now(),
    })
    return result.nextRunAt === undefined
      ? { ...result.detail }
      : { ...result.detail, nextRunAt: result.nextRunAt }
  }

  return {
    handlers: (jobName) => {
      if (jobName === DAILY_CLEANUP_JOB || jobName.startsWith(REMINDER_TICK_PREFIX)) {
        return wakerHandler
      }
      return null
    },
    manifest: referenceManifest,
    runs,
    async runScheduled({ cron, scheduledTime }) {
      const declarative = referenceManifest.find((job) => job.cron === cron)
      if (declarative === undefined) {
        throw new Error(
          `未知 cron 表达式：${cron}（原生模式的 [triggers] 必须与本示例的 referenceManifest 逐字一致）`,
        )
      }
      const { record } = await execute({
        jobName: declarative.name,
        source: 'scheduled',
        executionId: null,
        scheduledFor: scheduledTime.getTime(),
        payload: declarative.payload ?? null,
        now: Date.now(),
      })
      return record
    },
  }
}

interface RunJobRecordPair {
  record: JobRunRecord
  result: RunJobResult
}

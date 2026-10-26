import type { ExecutionTrigger, JobKind, JsonValue } from '../do/types'

/**
 * 回调协议 v2 —— **冻结契约**（B3 定死，B5 SDK 与下游接入方按此对齐，不得私自变更）。
 *
 * 语义严格按父单 SPEC §4：
 *   - 下游以 Hono 路由挂载 `/_waker/execute`，平台同步 POST；
 *   - handler 必须 await 到业务完成（或已转交下游自己的队列）才回 2xx；
 *   - 每项目独立 signing key，HMAC-SHA256 覆盖 `timestamp + executionId + jobId + body`，
 *     带时间窗防重放；
 *   - `executionId` 随回调下发，下游落表去重；
 *   - one-shot 执行的回调响应可携带 `nextRunAt` 自续。
 *
 * 本文件只放「协议本身」（常量、请求体、响应体、签名串拼法），
 * 签名计算在 `sign.ts`，投递在 `client.ts`，平台侧执行编排在 `queue/consumer.ts`。
 */

/** 协议版本号：写进请求体的 `protocolVersion`，也是签名头的前缀（`v2=`）。 */
export const CALLBACK_PROTOCOL_VERSION = 2

/** 回调路径：下游 SDK 在 `/_waker` 前缀下挂载的 endpoint（B5 对齐）。 */
export const CALLBACK_PATH = '/_waker/execute'

/** 回调签名使用的算法（写进契约，便于日后轮换）。 */
export const CALLBACK_SIGNATURE_ALGORITHM = 'HMAC-SHA256'

/**
 * 时间窗（秒）：`|now - X-Waker-Timestamp| > 300` 即视为重放/过期请求，下游必须拒收。
 * 5 分钟 = 覆盖 Queue 重试与网络抖动，又不给重放留窗口（与 GitHub / Stripe 系默认一致）。
 */
export const CALLBACK_TIMESTAMP_TOLERANCE_SECONDS = 300

/**
 * 自续上限（毫秒）：`nextRunAt` 最远只能落在「本次执行时刻 + 366 天」之内。
 * 防失控的唯一闸门——下游算错 / 恶意把任务续到 100 年后会让该 job 永久占坑且无人发现。
 */
export const MAX_SELF_RENEWAL_HORIZON_MS = 366 * 24 * 60 * 60 * 1000

/** HTTP 头名（冻结）：下游按这些名字取签名材料。 */
export const CALLBACK_HEADERS = {
  /** epoch **秒**（十进制字符串），参与签名。 */
  timestamp: 'X-Waker-Timestamp',
  /** 本次执行 id（= 下游幂等键），参与签名。 */
  executionId: 'X-Waker-Execution-Id',
  /** 任务 id，参与签名。 */
  jobId: 'X-Waker-Job-Id',
  /** 项目 id，便于下游快速路由/排查；不参与签名（已在 body 里）。 */
  projectId: 'X-Waker-Project-Id',
  /** 第几次投递（0 = 首次），便于排查；不参与签名（已在 body 里）。 */
  attempt: 'X-Waker-Attempt',
  /** `v2=<小写 hex>`，参与签名校验。 */
  signature: 'X-Waker-Signature',
  /** 协议版本，便于下游做灰度。 */
  protocolVersion: 'X-Waker-Protocol-Version',
} as const

/** 签名头前缀：`v2=<hex>`。版本号进前缀是为了日后换算法时不静默误判。 */
export const CALLBACK_SIGNATURE_PREFIX = `v${CALLBACK_PROTOCOL_VERSION}=`

/**
 * 签名规范串（**冻结**，下游必须逐字节照此拼接）：
 *
 * ```
 * <timestamp>\n<executionId>\n<jobId>\n<rawBody>
 * ```
 *
 * - `timestamp` = `X-Waker-Timestamp` 头里的原始十进制字符串（不做数值归一，避免 `1730000000` 与
 *   `1730000000.0` 这类等价写法产生不同签名）；
 * - `rawBody` = **请求体原始字节按 UTF-8 解码后的字符串**（下游必须用未解析的原始 body，
 *   不能 `JSON.stringify(JSON.parse(body))` —— 键序与空白会变，签名必然不匹配）；
 * - 三个 id/时间戳不含换行，所以以 `\n` 分隔无歧义。
 */
export function buildSignaturePayload(input: {
  timestamp: string
  executionId: string
  jobId: string
  body: string
}): string {
  return `${input.timestamp}\n${input.executionId}\n${input.jobId}\n${input.body}`
}

/** 回调请求体（冻结结构）：平台 POST 给下游 `/_waker/execute` 的 JSON。 */
export interface CallbackRequestBody {
  /** 协议版本，恒为 2。 */
  protocolVersion: typeof CALLBACK_PROTOCOL_VERSION
  /** 执行 id：下游幂等键（同一次执行的重试会带同一个 executionId）。 */
  executionId: string
  /** 任务 id（同一 job 的多次执行共享，自续后仍是同一个 job id）。 */
  jobId: string
  projectId: string
  /** 任务名（= 下游 jobs 表里的 key，下游据此分发到业务 handler）。 */
  jobName: string
  kind: JobKind
  trigger: ExecutionTrigger
  /** 是否补跑（错过窗口后按 misfirePolicy 补的那一次）。 */
  misfire: boolean
  /** 第几次投递，0 = 首次（重试时递增，可用来打日志/告警）。 */
  attempt: number
  /** 名义到期时刻（epoch ms）。 */
  scheduledFor: number
  /** 本次实际上报时刻（epoch ms，含抖动，约等于下游收到请求的时间）。 */
  dispatchedAt: number
  /** 平台侧超时（秒）：下游应在此之前返回，否则请求会被 abort 并按失败重试。 */
  timeoutSeconds: number
  /** 任务载荷（不透明 JSON，平台不解析，原样透传）。 */
  payload: JsonValue
}

/**
 * 回调响应体（冻结）：2xx + JSON 即视为成功执行。
 *
 * 只有 one-shot 任务会看 `nextRunAt`：带 = 以同一 job 系列续期，不带（或 null）= 任务完结。
 */
export interface CallbackResponseBody {
  /**
   * 自续的下一次执行时刻：epoch 毫秒数字或 ISO 8601 字符串。
   * 平台校验（合法时间戳 / 严格晚于本次执行时刻 / 不超过 366 天上限）通过后生效；
   * 校验失败**不影响本次执行成功**，只在执行记录里留 `renewal_error`。
   */
  nextRunAt?: number | string | null
  /** 平台忽略的其它字段（下游可自由返回业务信息）。 */
  [key: string]: unknown
}

/**
 * 把 `projects.callback_url` 规范化成完整回调地址。
 *
 * 契约：`projects.callback_url` 存项目根地址（如 `https://enotify.example.com`，不带路径），
 * 平台拼 `/_waker/execute`。允许调用方直接给出以 `/_waker/execute` 结尾的完整地址（幂等）。
 */
export function resolveCallbackUrl(baseUrl: string): string {
  const trimmed = baseUrl.trim().replace(/\/+$/, '')
  if (trimmed.endsWith(CALLBACK_PATH)) return trimmed
  return `${trimmed}${CALLBACK_PATH}`
}

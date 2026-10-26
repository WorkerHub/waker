/**
 * 回调协议 v2 —— **SDK 侧副本**，与平台 `src/callback/protocol.ts` 逐字对齐。
 *
 * 为什么是副本而不是 `import '../../src/callback/protocol'`：SDK 要能被下游项目**整目录拷走**
 * （下游仓库看不到本仓的 `src/`），因此 client 只依赖 `hono` + Workers 运行时原生能力，
 * 不 import 平台内部任何模块。副本与冻结契约的一致性由 `tests/client-contract.test.ts`
 * 逐项断言（常量 / 头名 / 签名规范串 / 请求响应结构都对比），漂移会直接测试失败。
 *
 * 协议语义见父单 SPEC §4（B3 冻结）：
 *   - 下游以 Hono 路由挂载 `/_waker`，平台同步 POST `/_waker/execute`；
 *   - handler 必须 await 到业务完成才回 2xx（平台以 2xx 判成功，非 2xx 走重试/死信）；
 *   - 每项目独立 signing key，HMAC-SHA256 覆盖 `timestamp + executionId + jobId + body`，带时间窗防重放；
 *   - `executionId` 随回调下发，下游落表去重；
 *   - one-shot 执行的回调响应可携带 `nextRunAt` 自续。
 */

/** 协议版本号：写进请求体的 `protocolVersion`，也是签名头的前缀（`v2=`）。 */
export const CALLBACK_PROTOCOL_VERSION = 2

/** 下游挂载前缀：`app.route('/_waker', createWakerReceiver({ jobs }))`。 */
export const CALLBACK_MOUNT_PATH = '/_waker'

/** 回调 endpoint：平台投递的完整路径（= 挂载前缀 + `/execute`）。 */
export const CALLBACK_PATH = '/_waker/execute'

/** 回调签名算法（写进契约，便于日后轮换）。 */
export const CALLBACK_SIGNATURE_ALGORITHM = 'HMAC-SHA256'

/** 时间窗（秒）：`|now - X-Waker-Timestamp| > 300` 视为重放/过期请求，下游必须拒收。 */
export const CALLBACK_TIMESTAMP_TOLERANCE_SECONDS = 300

/** 自续上限（毫秒）：`nextRunAt` 最远只能落在「本次执行时刻 + 366 天」之内。 */
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

/** 签名头前缀：`v2=<hex>`。 */
export const CALLBACK_SIGNATURE_PREFIX = `v${CALLBACK_PROTOCOL_VERSION}=`

/** 任务两类型（与平台 `JobKind` 一致）。 */
export type JobKind = 'cron' | 'one_shot'

/** 触发来源（与平台 `ExecutionTrigger` 一致）。 */
export type ExecutionTrigger = 'schedule' | 'manual'

/** 不透明载荷（平台不解析，原样透传）。 */
export type JsonValue =
  | string
  | number
  | boolean
  | null
  | JsonValue[]
  | { [key: string]: JsonValue }

/**
 * 签名规范串（**冻结**，逐字节照此拼接）：
 *
 * ```
 * <timestamp>\n<executionId>\n<jobId>\n<rawBody>
 * ```
 *
 * - `timestamp` = `X-Waker-Timestamp` 头里的原始十进制字符串（不做数值归一）；
 * - `rawBody` = 请求体**原始字节按 UTF-8 解码后的字符串**（必须用未解析的 body，
 *   `JSON.stringify(JSON.parse(body))` 会改键序/空白，签名必然不匹配）。
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
  /** 第几次投递，0 = 首次。 */
  attempt: number
  /** 名义到期时刻（epoch ms）。 */
  scheduledFor: number
  /** 本次实际上报时刻（epoch ms，含抖动）。 */
  dispatchedAt: number
  /** 平台侧超时（秒）：下游应在此之前返回，否则请求会被 abort 并按失败重试。 */
  timeoutSeconds: number
  /** 任务载荷（不透明 JSON，平台不解析，原样透传）。 */
  payload: JsonValue
}

/** 自续时刻：epoch 毫秒数字或 ISO 8601 字符串。 */
export type NextRunAt = number | string

/** 回调响应体（冻结）：2xx + JSON 即视为成功执行；只有 one-shot 会看 `nextRunAt`。 */
export interface CallbackResponseBody {
  /**
   * 自续的下一次执行时刻。平台校验（合法时间戳 / 严格晚于本次执行时刻 / 不超过 366 天上限）
   * 通过后以同一 job 系列续期；校验失败不影响本次执行成功，只在执行记录里留 `renewal_error`。
   */
  nextRunAt?: NextRunAt | null
  /** 平台忽略的其它字段（下游可自由返回业务信息）。 */
  [key: string]: unknown
}

/** 把项目根地址规范化为完整回调地址（平台侧同款实现：契约在这里是对称的）。 */
export function resolveCallbackUrl(baseUrl: string): string {
  const trimmed = baseUrl.trim().replace(/\/+$/, '')
  if (trimmed.endsWith(CALLBACK_PATH)) return trimmed
  return `${trimmed}${CALLBACK_PATH}`
}

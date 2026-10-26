import type { Env } from '../env'
import { getWakerStub } from './instance'
import type {
  DeadLetterInput,
  DeadLetterView,
  PrepareExecutionInput,
  PrepareExecutionResult,
  RecordExecutionInput,
  RecordExecutionResult,
  ReplayDeadLetterInput,
  ReplayDeadLetterResult,
  WakerResult,
} from './types'
import type { WakerDO } from './waker-do'

/**
 * B3 执行引擎 RPC 面：queue consumer 独占调用的四个方法。
 *
 * 为什么不直接用 `DurableObjectStub<WakerDO>`：CF 的 RPC 存根类型会对每个方法的返回值做
 * 深层映射，遇到 `JsonValue` 这种递归类型时 TS 会直接 `TS2589`（type instantiation is
 * excessively deep）。B2 的测试也是用「本地契约 interface + 断言」绕开的同一条路。
 *
 * 安全性不靠人肉自觉：下面的编译期断言保证 **WakerDO 真的实现了这组签名**，
 * 任何一边改了出入参都会在 `tsc --noEmit` 阶段报错。
 */
export interface WakerEngineRpc {
  prepareExecution(input: PrepareExecutionInput): Promise<WakerResult<PrepareExecutionResult>>
  recordExecutionResult(input: RecordExecutionInput): Promise<WakerResult<RecordExecutionResult>>
  recordDeadLetter(input: DeadLetterInput): Promise<WakerResult<DeadLetterView>>
  replayDeadLetter(input: ReplayDeadLetterInput): Promise<WakerResult<ReplayDeadLetterResult>>
}

/** 编译期断言：WakerDO 满足执行引擎 RPC 契约。 */
const _engineRpcCompatible: WakerEngineRpc = {} as WakerDO
void _engineRpcCompatible

/** 取执行引擎 RPC 存根（consumer 用）。 */
export function getEngineStub(env: Env): WakerEngineRpc {
  return getWakerStub(env) as unknown as WakerEngineRpc
}

import type { Env } from '../env'
import type { WakerDO } from './waker-do'

/** 唯一实例名：全平台只有一个 WakerDO。 */
export const WAKER_DO_INSTANCE_NAME = 'waker'

/**
 * 全平台唯一 WakerDO 实例的取用入口（RPC 存根）。
 *
 * 单一实例（`idFromName('waker')`）是硬约束：真源只有一份 SQLite，
 * 不分片（规格 §8：本版单人自托管）。
 */
export function getWakerStub(env: Env): DurableObjectStub<WakerDO> {
  return env.WAKER_DO.get(env.WAKER_DO.idFromName(WAKER_DO_INSTANCE_NAME))
}

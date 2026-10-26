import type { Env } from '../env'
import { getWakerStub } from './instance'
import type {
  BootstrapTokenView,
  EmailSendConfig,
  MeView,
  OneTimeCodeView,
  PasskeyView,
  PasswordLoginView,
  SetupStateView,
  SystemSettingsView,
  TwoFactorMethod,
  UpdateEmailSettingsInput,
  UpdateUserInput,
  UserView,
  WebAuthnOptionsView,
} from './auth-types'
import type {
  CreateJobInput,
  CreateProjectInput,
  CreateProjectResult,
  JobRef,
  JobView,
  ListDeadLettersQuery,
  ListDeadLettersResult,
  ListExecutionsQuery,
  ListExecutionsResult,
  ListJobsQuery,
  ListJobsResult,
  ListProjectsResult,
  ManualTriggerInput,
  ManualTriggerResult,
  ProjectAuthView,
  ProjectView,
  ReplayDeadLetterInput,
  ReplayDeadLetterResult,
  RotateProjectTokenInput,
  RotateProjectTokenResult,
  RotateSigningKeyInput,
  RotateSigningKeyResult,
  SyncManifestInput,
  SyncManifestResult,
  SystemStatusView,
  UpdateJobInput,
  UpdateProjectInput,
  VerifyProjectTokenInput,
  WakerResult,
} from './types'
import type { WakerDO } from './waker-do'

/**
 * HTTP 层（注册 API + 管理面 API）用到的 RPC 面。
 *
 * 与 `engine-rpc.ts` 同一套路、同一个原因：`DurableObjectStub<WakerDO>` 会对每个返回类型
 * 做深层映射，遇到递归的 `JsonValue` 会直接 `TS2589`；用本地契约 interface + 编译期断言
 * 既躲开类型深度，又保证 WakerDO 真的实现了这些签名（任一边改动都会 `tsc` 报错）。
 *
 * 这里只列**对外 HTTP 面真正用到**的方法：新增/删除一个 RPC 时必须同步这份清单，
 * 评审也能一眼看出「HTTP 暴露了哪些能力」。
 */
export interface WakerApiRpc {
  // 任务生命周期（B2 冻结契约）
  createJob(input: CreateJobInput): Promise<WakerResult<JobView>>
  cancelJob(ref: JobRef): Promise<WakerResult<JobView>>
  pauseJob(ref: JobRef): Promise<WakerResult<JobView>>
  resumeJob(ref: JobRef): Promise<WakerResult<JobView>>
  manualTrigger(input: ManualTriggerInput): Promise<WakerResult<ManualTriggerResult>>
  getJob(ref: JobRef): Promise<WakerResult<JobView | null>>
  listJobs(query?: ListJobsQuery): Promise<WakerResult<ListJobsResult>>
  // B6 新增：执行记录 / 死信查询（B7 挂到 HTTP 面）
  listExecutions(query?: ListExecutionsQuery): Promise<WakerResult<ListExecutionsResult>>
  listDeadLetters(query?: ListDeadLettersQuery): Promise<WakerResult<ListDeadLettersResult>>
  // B3 新增：死信重放（B7 挂到 HTTP 面）
  replayDeadLetter(input: ReplayDeadLetterInput): Promise<WakerResult<ReplayDeadLetterResult>>
  // B4 新增：编辑任务 / 声明式对账
  updateJob(input: UpdateJobInput): Promise<WakerResult<JobView>>
  syncManifest(input: SyncManifestInput): Promise<WakerResult<SyncManifestResult>>
  // B4 新增：项目管理与凭据
  createProject(input: CreateProjectInput): Promise<WakerResult<CreateProjectResult>>
  listProjects(): Promise<WakerResult<ListProjectsResult>>
  getProject(input: { projectId: string }): Promise<WakerResult<ProjectView | null>>
  updateProject(input: UpdateProjectInput): Promise<WakerResult<ProjectView>>
  rotateProjectToken(input: RotateProjectTokenInput): Promise<WakerResult<RotateProjectTokenResult>>
  rotateSigningKey(input: RotateSigningKeyInput): Promise<WakerResult<RotateSigningKeyResult>>
  verifyProjectToken(input: VerifyProjectTokenInput): Promise<WakerResult<ProjectAuthView | null>>
  // 只读状态
  getSystemStatus(): Promise<WakerResult<SystemStatusView>>

  // ── 用户体系 / 2FA / 邮件配置（ONE-462） ──
  authSetupState(): Promise<WakerResult<SetupStateView>>
  authBeginSetup(input: { setupSecret: unknown; ip: string }): Promise<WakerResult<BootstrapTokenView>>
  authCreateFirstAdmin(input: {
    bootstrapToken: unknown
    email: unknown
    password: unknown
    displayName: unknown
  }): Promise<WakerResult<UserView>>
  authRegister(input: {
    email: unknown
    password: unknown
    displayName: unknown
    ip: string
  }): Promise<WakerResult<UserView>>
  authBeginLogin(input: {
    email: unknown
    password: unknown
    ip: string
  }): Promise<WakerResult<PasswordLoginView>>
  authVerifyTotp(input: { sessionRef: unknown; code: unknown }): Promise<WakerResult<UserView>>
  authVerifyEmailOtp(input: { sessionRef: unknown; code: unknown }): Promise<WakerResult<UserView>>
  authSendLoginEmailOtp(input: { sessionRef: unknown }): Promise<WakerResult<OneTimeCodeView>>
  authDiscardChallenge(input: { challengeId: unknown }): Promise<WakerResult<{ discarded: boolean }>>
  authPasskeyLoginOptions(input: {
    sessionRef: unknown
    rpId: unknown
  }): Promise<WakerResult<WebAuthnOptionsView>>
  authPasskeyLoginVerify(input: {
    sessionRef: unknown
    rpId: unknown
    origin: unknown
    response: unknown
  }): Promise<WakerResult<UserView>>
  authGetSessionUser(input: { userId: string }): Promise<WakerResult<UserView>>
  authGetMe(input: { userId: string }): Promise<WakerResult<MeView>>
  authUpdateProfile(input: { userId: string; displayName: unknown }): Promise<WakerResult<MeView>>
  authChangePassword(input: {
    userId: string
    currentPassword: unknown
    newPassword: unknown
  }): Promise<WakerResult<{ changed: true }>>
  authTotpSetupStart(input: { userId: string }): Promise<WakerResult<{ secret: string; uri: string }>>
  authTotpSetupConfirm(input: { userId: string; code: unknown }): Promise<WakerResult<MeView>>
  authTotpDisable(input: { userId: string; password: unknown }): Promise<WakerResult<MeView>>
  authEmailOtpSetupSend(input: { userId: string }): Promise<WakerResult<OneTimeCodeView>>
  authEmailOtpEnable(input: { userId: string; code: unknown }): Promise<WakerResult<MeView>>
  authEmailOtpDisable(input: { userId: string; password: unknown }): Promise<WakerResult<MeView>>
  authPasskeyRegisterOptions(input: {
    userId: string
    rpId: unknown
  }): Promise<WakerResult<WebAuthnOptionsView>>
  authPasskeyRegisterVerify(input: {
    userId: string
    rpId: unknown
    origin: unknown
    response: unknown
    name: unknown
  }): Promise<WakerResult<PasskeyView>>
  authListPasskeys(input: { userId: string }): Promise<WakerResult<{ passkeys: PasskeyView[] }>>
  authRenamePasskey(input: {
    userId: string
    credentialId: string
    name: unknown
  }): Promise<WakerResult<{ passkeys: PasskeyView[] }>>
  authDeletePasskey(input: {
    userId: string
    credentialId: string
    password: unknown
  }): Promise<WakerResult<{ passkeys: PasskeyView[] }>>
  authSetPreferredMethod(input: {
    userId: string
    method: TwoFactorMethod
  }): Promise<WakerResult<MeView>>
  authListUsers(): Promise<WakerResult<{ users: UserView[] }>>
  authUpdateUser(input: UpdateUserInput): Promise<WakerResult<UserView>>
  authDeleteUser(input: { actorId: string; userId: string }): Promise<WakerResult<{ deleted: true }>>
  authGetSystemSettings(): Promise<WakerResult<SystemSettingsView>>
  authSetRegistrationEnabled(input: {
    actorId: string
    enabled: boolean
  }): Promise<WakerResult<SystemSettingsView>>
  authUpdateEmailSettings(input: {
    actorId: string
    settings: UpdateEmailSettingsInput
  }): Promise<WakerResult<SystemSettingsView>>
  authGetEmailSendConfig(): Promise<WakerResult<EmailSendConfig>>
}

/** 编译期断言：WakerDO 满足 HTTP 面用到的 RPC 契约。 */
const _apiRpcCompatible: WakerApiRpc = {} as WakerDO
void _apiRpcCompatible

/** 取 HTTP 层用的 RPC 存根。 */
export function getApiStub(env: Env): WakerApiRpc {
  return getWakerStub(env) as unknown as WakerApiRpc
}

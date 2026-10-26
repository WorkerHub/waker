#!/usr/bin/env bash
# 密钥落地管线（舰队统一标准）
#
# 用法：
#   scripts/ci/gen-secrets-file.sh          生成 $RUNNER_TEMP/secrets.json（0600）
#   scripts/ci/gen-secrets-file.sh --check  只做逐键非空校验，不写文件
#
# 行为契约：
#   - 项目自身 secret 仅 SETUP_SECRET / JWT_SECRET，只从环境变量读取；
#   - 逐键非空校验，任一缺失/空值即退出码 1（失败关闭，绝不生成半成品文件）；
#   - 只输出键名与状态，绝不打印任何密钥值；
#   - 生成的文件权限强制 0600，并回读校验，不达标即失败关闭。
set -euo pipefail

# 写进 secrets.json、注入 Worker 的键（顺序固定）
SECRETS_FILE_KEYS=(SETUP_SECRET JWT_SECRET)
# 部署链路还要求的凭据（组织级，不进 secrets.json）
DEPLOY_CRED_KEYS=(CLOUDFLARE_API_TOKEN CLOUDFLARE_ACCOUNT_ID)

mode="write"
case "${1-}" in
  --check) mode="check" ;;
  "") ;;
  *)
    echo "用法: $0 [--check]" >&2
    exit 2
    ;;
esac

is_empty() {
  local key="$1"
  [ -z "${!key-}" ]
}

missing=()
for key in "${SECRETS_FILE_KEYS[@]}"; do
  is_empty "$key" && missing+=("$key")
done
if [ "$mode" = "check" ]; then
  for key in "${DEPLOY_CRED_KEYS[@]}"; do
    is_empty "$key" && missing+=("$key")
  done
fi

if [ ${#missing[@]} -gt 0 ]; then
  echo "::error::密钥未配齐，缺少：${missing[*]}（失败关闭，不生成 secrets.json，不部署）" >&2
  exit 1
fi

if [ "$mode" = "check" ]; then
  echo "OK: 部署所需凭据全部非空（${SECRETS_FILE_KEYS[*]} ${DEPLOY_CRED_KEYS[*]}）。"
  exit 0
fi

if [ -z "${RUNNER_TEMP-}" ]; then
  echo "::error::RUNNER_TEMP 未设置，拒绝把 secrets.json 写到不确定的位置" >&2
  exit 1
fi

out="$RUNNER_TEMP/secrets.json"

umask 077
# 用 node 序列化，避免 shell 拼接造成的 JSON 转义/注入问题；值只经环境变量传递。
SECRETS_FILE_KEYS_JOINED="$(IFS=,; echo "${SECRETS_FILE_KEYS[*]}")" \
  node -e '
    const keys = process.env.SECRETS_FILE_KEYS_JOINED.split(",");
    const payload = Object.fromEntries(keys.map((key) => [key, process.env[key]]));
    process.stdout.write(JSON.stringify(payload));
  ' >"$out"

chmod 600 "$out"

# 回读校验：权限 0600 + 每个键都存在且非空
perm="$(stat -c '%a' "$out" 2>/dev/null || stat -f '%Lp' "$out")"
if [ "$perm" != "600" ]; then
  echo "::error::secrets.json 权限为 ${perm}，要求 600（失败关闭）" >&2
  rm -f "$out"
  exit 1
fi

for key in "${SECRETS_FILE_KEYS[@]}"; do
  if ! SECRETS_FILE_PATH="$out" KEY="$key" node -e '
      const fs = require("node:fs");
      const parsed = JSON.parse(fs.readFileSync(process.env.SECRETS_FILE_PATH, "utf8"));
      const value = parsed[process.env.KEY];
      process.exit(typeof value === "string" && value.length > 0 ? 0 : 1);
    '; then
    echo "::error::secrets.json 缺少非空键 ${key}（失败关闭）" >&2
    rm -f "$out"
    exit 1
  fi
done

echo "OK: 已生成 ${out}（权限 600），键：${SECRETS_FILE_KEYS[*]}"

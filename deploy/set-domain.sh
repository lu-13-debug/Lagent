#!/usr/bin/env bash
# 把已部署的 Lagent 切换到备案通过的正式域名，并让 Caddy 重新申请公共证书。
#
# 用法（在服务器 /opt/lagent 目录执行）：
#   sudo bash deploy/set-domain.sh analysis.example.com
#
# 做的事：
#   1. 校验域名格式，并核对 A 记录是否指向本机公网 IP；
#   2. 备份 .env 和临时的 compose.ip.yaml；
#   3. 写回 LAGENT_DOMAIN / PUBLIC_URL；
#   4. 停用临时叠加配置（sslip.io + 8443），回到标准 80/443；
#   5. 重建 app 与 caddy，等待 healthy 并验证 /api/runtime。
set -euo pipefail

DOMAIN="${1:-}"
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT"

if [[ -z "$DOMAIN" ]]; then
  echo "用法：sudo bash deploy/set-domain.sh <已备案域名>" >&2
  exit 1
fi
if [[ ! "$DOMAIN" =~ ^([a-z0-9]([a-z0-9-]*[a-z0-9])?\.)+[a-z]{2,}$ ]]; then
  echo "域名格式不对：$DOMAIN（不要带 https://、端口或路径，也不要填 IP）" >&2
  exit 1
fi
if [[ ! -f .env ]]; then
  echo "没有找到 $ROOT/.env，请先按 docs/ubuntu-https-guide.md 初始化。" >&2
  exit 1
fi

STAMP="$(date +%Y%m%d-%H%M%S)"
BACKUP="backups/domain-$STAMP"
mkdir -p "$BACKUP"
cp .env "$BACKUP/.env"
[[ -f compose.ip.yaml ]] && cp compose.ip.yaml "$BACKUP/compose.ip.yaml"
echo "已备份到 $BACKUP"

PUBLIC_IP="$(curl -fsS --max-time 8 https://api.ipify.org 2>/dev/null || curl -fsS --max-time 8 http://ifconfig.me 2>/dev/null || true)"
RESOLVED="$(getent ahostsv4 "$DOMAIN" 2>/dev/null | awk 'NR==1{print $1}' || true)"
echo "域名 A 记录：${RESOLVED:-未解析到}    本机公网 IP：${PUBLIC_IP:-未知}"
if [[ -z "$RESOLVED" ]]; then
  echo "警告：$DOMAIN 还没有解析到任何地址，Caddy 会因为拿不到证书而失败。" >&2
elif [[ -n "$PUBLIC_IP" && "$RESOLVED" != "$PUBLIC_IP" ]]; then
  echo "警告：A 记录 $RESOLVED 与本机公网 IP $PUBLIC_IP 不一致，请先改 DNS 再继续。" >&2
  read -r -p "仍然继续？[y/N] " answer
  [[ "$answer" == "y" || "$answer" == "Y" ]] || exit 1
fi

# 用 awk 原地改写，保留其余行与注释；缺少的键追加到末尾。
set_key() {
  local key="$1" value="$2"
  if grep -qE "^${key}=" .env; then
    awk -v k="$key" -v v="$value" 'BEGIN{FS=OFS="="} $1==k{$0=k"="v} {print}' .env > .env.tmp
    mv .env.tmp .env
  else
    printf '\n%s=%s\n' "$key" "$value" >> .env
  fi
}
set_key LAGENT_DOMAIN "$DOMAIN"
set_key PUBLIC_URL "https://$DOMAIN"
chmod 600 .env
echo "LAGENT_DOMAIN=$DOMAIN"

if [[ -f compose.ip.yaml ]]; then
  mv compose.ip.yaml "compose.ip.yaml.disabled"
  echo "已停用临时叠加配置 compose.ip.yaml（改名保留备份），回到 80/443。"
fi

docker compose -f compose.yaml config --quiet
docker compose -f compose.yaml up -d --build --force-recreate app caddy
docker compose -f compose.yaml ps

echo "等待 https://$DOMAIN/api/runtime 就绪（证书签发通常需要 10-60 秒）..."
for i in $(seq 1 24); do
  body="$(curl -fsS --max-time 10 "https://$DOMAIN/api/runtime" 2>/dev/null || true)"
  if [[ -n "$body" ]]; then
    echo "$body"
    echo "完成：https://$DOMAIN"
    exit 0
  fi
  sleep 5
done

echo "HTTPS 还没通。看日志排查：" >&2
echo "  docker compose -f compose.yaml logs --tail=200 caddy" >&2
exit 1

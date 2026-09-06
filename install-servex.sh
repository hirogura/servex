#!/usr/bin/env bash
# =============================================================================
#  servEX v.0.9.0 セットアップスクリプト
#  - Ubuntu Serve のファイル操作をブラウザから行う
#  - Tailscale Serve で Tailnet 内のみに 3359 番ポートで公開
# =============================================================================
set -euo pipefail

INSTALL_DIR="/opt/servex"
PORT=3359
SERVICE_NAME="servex"
NODE_MIN_VERSION=18
NODE_VERSION_TO_INSTALL="22"

# ── 色付きログ ──
info()  { echo -e "\033[1;34m[INFO]\033[0m  $*"; }
ok()    { echo -e "\033[1;32m[ OK ]\033[0m  $*"; }
warn()  { echo -e "\033[1;33m[WARN]\033[0m  $*"; }
die()   { echo -e "\033[1;31m[ERR ]\033[0m  $*" >&2; exit 1; }

# ── Node.js 自動インストール ──
install_nodejs() {
  info "Node.js をインストール中..."
  if [ -f /etc/debian_version ]; then
    info "Debian/Ubuntu を検出。NodeSource からインストールします..."
    apt-get update -qq
    apt-get install -y -qq ca-certificates curl gnupg
    mkdir -p /etc/apt/keyrings
    curl -fsSL https://deb.nodesource.com/gpgkey/nodesource-repo.gpg.key | gpg --dearmor -o /etc/apt/keyrings/nodesource.gpg 2>/dev/null || true
    echo "deb [signed-by=/etc/apt/keyrings/nodesource.gpg] https://deb.nodesource.com/node_${NODE_VERSION_TO_INSTALL}.x nodistro main" | tee /etc/apt/sources.list.d/nodesource.list >/dev/null
    apt-get update -qq
    apt-get install -y -qq nodejs
  elif [ -f /etc/redhat-release ]; then
    info "RHEL/CentOS を検出。NodeSource からインストールします..."
    curl -fsSL https://rpm.nodesource.com/setup_${NODE_VERSION_TO_INSTALL}.x | bash -
    yum install -y nodejs
  else
    die "サポートされていない OS です。手動で Node.js ${NODE_MIN_VERSION} 以上をインストールしてください"
  fi
  if ! command -v node >/dev/null 2>&1; then
    die "Node.js のインストールに失敗しました"
  fi
  ok "Node.js v$(node -v) のインストール完了"
}

# ── 前提チェック ──
info "前提確認..."
if ! command -v node >/dev/null 2>&1; then
  warn "Node.js が見つかりません"
  install_nodejs
fi
NODE_VERSION=$(node -v | sed 's/v//' | cut -d. -f1)
if [ "$NODE_VERSION" -lt "$NODE_MIN_VERSION" ]; then
  warn "Node.js v${NODE_VERSION} は古いです (必要: v${NODE_MIN_VERSION}以上)"
  install_nodejs
fi
if ! command -v npm >/dev/null 2>&1; then
  warn "npm が見つかりません。Node.js を (再)インストールして npm を導入します..."
  install_nodejs
  if ! command -v npm >/dev/null 2>&1; then
    die "npm が見つかりません。インストールに失敗しました"
  fi
fi
ok "前提 OK (Node.js v$(node -v), npm v$(npm -v))"

# ── ディレクトリ作成 ──
info "ディレクトリ作成..."
mkdir -p "${INSTALL_DIR}"
ok "ディレクトリ作成完了"

# ── rsync 確認・インストール ──
if ! command -v rsync >/dev/null 2>&1; then
  warn "rsync が見つかりません。インストールします..."
  if [ -f /etc/debian_version ]; then
    apt-get update -qq
    apt-get install -y -qq rsync
  elif [ -f /etc/redhat-release ]; then
    command -v dnf >/dev/null 2>&1 && dnf install -y rsync || yum install -y rsync
  else
    die "rsync を自動インストールできませんでした。手動でインストールしてください"
  fi
  if ! command -v rsync >/dev/null 2>&1; then
    die "rsync のインストールに失敗しました。手動でインストールしてください"
  fi
  ok "rsync インストール完了"
fi

# ── ファイルコピー ──
info "ファイルをコピー中..."
SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
if [ -d "${SCRIPT_DIR}/server" ] && [ -d "${SCRIPT_DIR}/public" ]; then
  rsync -a --exclude='node_modules' "${SCRIPT_DIR}/" "${INSTALL_DIR}/"
else
  die "インストールスクリプトと同じディレクトリに server/ と public/ が見つかりません"
fi
ok "ファイルコピー完了"

# ── npm install ──
info "npm install 実行中..."
cd "${INSTALL_DIR}/server"
npm install --production 2>&1 | tail -5
ok "npm install 完了"

# ── systemd サービス作成 ──
NODE_BIN=$(command -v node)
info "systemd サービスを作成 (Node: ${NODE_BIN})..."
cat > "/etc/systemd/system/${SERVICE_NAME}.service" << SVCEOF
[Unit]
Description=servEX File Manager
After=network.target

[Service]
Type=simple
WorkingDirectory=${INSTALL_DIR}/server
ExecStart=${NODE_BIN} server.js
Restart=always
RestartSec=5
Environment=NODE_ENV=production

[Install]
WantedBy=multi-user.target
SVCEOF
ok "サービスファイル作成完了"

# ── 古いプロセスを停止 ──
if systemctl is-active --quiet "${SERVICE_NAME}" 2>/dev/null; then
  info "既存の ${SERVICE_NAME} サービスを停止中..."
  systemctl stop "${SERVICE_NAME}"
fi
pkill -f "node server[.]js" 2>/dev/null || true
sleep 2

# ── サービス起動 ──
info "サービスを有効化・起動..."
systemctl daemon-reload
systemctl enable "${SERVICE_NAME}" 2>/dev/null || true
systemctl restart "${SERVICE_NAME}"
sleep 2

if systemctl is-active --quiet "${SERVICE_NAME}"; then
  ok "サービス起動完了"
else
  warn "サービスの起動に失敗しました。詳細を確認中..."
  journalctl -u "${SERVICE_NAME}" --no-pager -n 20 2>/dev/null || true
  die "サービスの起動に失敗しました"
fi

# ── Tailscale Serve 設定 ──
if command -v tailscale >/dev/null 2>&1; then
  EXISTING_SERVE=$(tailscale serve status 2>/dev/null || true)
  if echo "${EXISTING_SERVE}" | grep -q ":${PORT}"; then
    warn "ポート ${PORT} はすでに Tailscale Serve に登録されています。スキップします。"
  else
    info "Tailscale Serve にポート ${PORT} を追加..."
    tailscale serve --bg --https="${PORT}" "http://127.0.0.1:${PORT}"
    ok "servEX の Tailscale Serve 設定追加完了"
  fi
else
  warn "Tailscale が見つかりません。Tailscale Serve の設定をスキップします。"
  warn "Tailscale をインストールした後、以下のコマンドを実行してください:"
  warn "  tailscale serve --bg --https=${PORT} http://127.0.0.1:${PORT}"
fi

# ── Tailscale 情報取得 ──
TS_HOSTNAME=""
if command -v tailscale >/dev/null 2>&1 && tailscale status >/dev/null 2>&1; then
  TS_HOSTNAME=$(tailscale status --json 2>/dev/null | python3 -c "import sys,json; print(json.load(sys.stdin)['Self']['DNSName'].rstrip('.'))" 2>/dev/null || true)
fi

# ── 完了サマリー ──
echo ""
echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
ok "servEX v.0.9.0 セットアップ完了！"
echo ""
if [ -n "${TS_HOSTNAME}" ]; then
  echo "  servEX      : https://${TS_HOSTNAME}:${PORT}"
else
  warn "Tailscale Serve の設定情報を取得できませんでした"
  echo "  servEX      : http://$(hostname -I 2>/dev/null | awk '{print $1}' || echo 'localhost'):${PORT}"
fi
echo ""
echo "  インストール先: ${INSTALL_DIR}"
echo "  ルート        : /"
echo "  ポート        : ${PORT}"
echo "  サービス      : systemctl status ${SERVICE_NAME}"
echo ""
echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"

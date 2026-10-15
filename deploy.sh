#!/usr/bin/env bash
# Zeno 一键部署（Linux / macOS）
#
# 做四件事：拉代码、构建、装成 systemd 常驻服务、配 Tailscale HTTPS
#
# 用法：
#   ./deploy.sh                      # 全新安装
#   ./deploy.sh --skip-tailscale     # 不配 Tailscale
#   ./deploy.sh --port 9000          # 换端口
#   ./deploy.sh --uninstall          # 卸载

set -euo pipefail

# ── 参数 ───────────────────────────────────────────
PORT=8788
INSTALL_DIR="$(cd "$(dirname "$0")" && pwd)"
SERVICE_NAME="zeno"
DO_TAILSCALE=1
ACTION=install

while [[ $# -gt 0 ]]; do
  case "$1" in
    --port) PORT="$2"; shift 2 ;;
    --dir) INSTALL_DIR="$2"; shift 2 ;;
    --skip-tailscale) DO_TAILSCALE=0; shift ;;
    --uninstall) ACTION=uninstall; shift ;;
    -h|--help)
      sed -n '2,12p' "$0" | sed 's/^# //'
      exit 0 ;;
    *) echo "未知参数: $1"; exit 1 ;;
  esac
done

# ── 颜色 ───────────────────────────────────────────
if [[ -t 1 ]]; then
  R=$'\033[31m' G=$'\033[32m' Y=$'\033[33m' B=$'\033[1m' N=$'\033[0m'
else
  R="" G="" Y="" B="" N=""
fi
step() { echo "${B}▸ $*${N}"; }
ok()   { echo "  ${G}✓${N} $*"; }
warn() { echo "  ${Y}!${N} $*"; }
die()  { echo "  ${R}✗${N} $*" >&2; exit 1; }

# ── 卸载 ───────────────────────────────────────────
if [[ "$ACTION" == "uninstall" ]]; then
  step "停止并移除服务"
  sudo systemctl stop "$SERVICE_NAME" 2>/dev/null || true
  sudo systemctl disable "$SERVICE_NAME" 2>/dev/null || true
  sudo rm -f "/etc/systemd/system/$SERVICE_NAME.service"
  sudo systemctl daemon-reload
  ok "已卸载（数据保留在 $INSTALL_DIR/data）"
  exit 0
fi

# ── 环境检查 ───────────────────────────────────────
step "检查环境"

command -v node >/dev/null || die "没装 Node.js。先装 Node 22+：https://nodejs.org"
NODE_VER="$(node -p 'process.versions.node')"
NODE_MAJOR="${NODE_VER%%.*}"
[[ "$NODE_MAJOR" -ge 22 ]] || die "Node 版本过低（当前 $NODE_VER）。需要 22+，因为用到内置的 node:sqlite"
ok "Node $NODE_VER"

command -v npm >/dev/null || die "没装 npm"
ok "npm $(npm -v)"

# 渲染浏览器：调用服务端自己的 findBrowser()，避免两套探测逻辑漂移。
# 找不到不算失败 —— 只有 fetch.mode="browser" 的插件需要它。
step "检查渲染浏览器（可选）"
BROWSER_CHECK="$(RENDER_MOD="$INSTALL_DIR/server/render.mjs" node --input-type=module -e '
import { pathToFileURL } from "node:url";
const m = await import(pathToFileURL(process.env.RENDER_MOD).href);
const b = m.findBrowser();
console.log(b ? `FOUND|${b.from}|${b.exe}` : "NONE");
' 2>/dev/null)"
if [[ "$BROWSER_CHECK" == FOUND\|* ]]; then
  ok "渲染浏览器：${BROWSER_CHECK##*|}（来源 $(echo "$BROWSER_CHECK" | cut -d'|' -f2)）"
else
  warn "没找到 chromium 系浏览器（Chrome / Chromium）。"
  warn "  不影响普通插件；但插件里写 fetch.mode=\"browser\" 的会报 503。"
  warn "  装一个 chromium，或设 ZENO_BROWSER 指向可执行文件。"
fi

if command -v systemctl >/dev/null; then
  HAS_SYSTEMD=1
  ok "systemd 可用（会装成常驻服务）"
else
  HAS_SYSTEMD=0
  warn "没有 systemd，将用 nohup 后台运行（重启后不会自启）"
fi

if [[ "$DO_TAILSCALE" == "1" ]]; then
  command -v tailscale >/dev/null || warn "没装 Tailscale，HTTPS 步骤会跳过"
fi

# ── 更新代码 ───────────────────────────────────────
step "更新代码"
if ! command -v git >/dev/null; then
  warn "没装 git，跳过拉取（沿用当前工作副本）"
elif [[ ! -d "$INSTALL_DIR/.git" ]]; then
  warn "这里不是 git 仓库（大概是解压装的），跳过拉取"
elif [[ -n "$(git -C "$INSTALL_DIR" status --porcelain)" ]]; then
  die "工作副本有未提交的改动，不动它。先 commit 或 stash，再部署（git status 看是什么）"
else
  BEFORE="$(git -C "$INSTALL_DIR" rev-parse HEAD)"
  git -C "$INSTALL_DIR" pull --ff-only || die "git pull --ff-only 没成功（本地和远端分叉了？）。手动处理完再部署"
  AFTER="$(git -C "$INSTALL_DIR" rev-parse HEAD)"
  if [[ "$BEFORE" != "$AFTER" ]]; then
    ok "代码已更新 ${BEFORE:0:7} → ${AFTER:0:7}"
  else
    ok "代码已是最新"
  fi
fi

# ── 依赖与构建 ─────────────────────────────────────
step "安装依赖"
cd "$INSTALL_DIR"
if [[ -f package-lock.json ]]; then
  npm ci
else
  npm install
fi

step "构建"
npm run build
[[ -d dist ]] || die "构建失败：dist/ 不存在"
ok "构建完成"

# ── 端口占用 ───────────────────────────────────────
step "检查端口 $PORT"
if command -v ss >/dev/null && ss -ltn 2>/dev/null | grep -q ":$PORT "; then
  die "端口 $PORT 已被占用。换个端口：./deploy.sh --port 9000"
fi
ok "端口空闲"

# ── systemd 服务 ───────────────────────────────────
if [[ "$HAS_SYSTEMD" == "1" ]]; then
  step "安装 systemd 服务"
  sudo tee "/etc/systemd/system/$SERVICE_NAME.service" >/dev/null <<EOF
[Unit]
Description=Zeno — 干净的网页阅读器
Documentation=https://github.com/ZikiP/Zeno
After=network-online.target tailscaled.service
Wants=network-online.target

[Service]
Type=simple
WorkingDirectory=$INSTALL_DIR
Environment=NODE_ENV=production
Environment=PORT=$PORT
ExecStart=$(command -v node) $INSTALL_DIR/server/index.mjs

# 崩溃自动重启，但别无限重启
Restart=on-failure
RestartSec=5

# 日志走 journald，用 journalctl -u zeno -f 看
StandardOutput=journal
StandardError=journal
SyslogIdentifier=$SERVICE_NAME

[Install]
WantedBy=multi-user.target
EOF

  sudo systemctl daemon-reload
  sudo systemctl enable "$SERVICE_NAME"
  sudo systemctl restart "$SERVICE_NAME"
  sleep 2

  if systemctl is-active --quiet "$SERVICE_NAME"; then
    ok "服务已启动并设为开机自启"
  else
    echo "${R}启动失败，日志：${N}"
    sudo journalctl -u "$SERVICE_NAME" -n 20 --no-pager
    exit 1
  fi
else
  step "后台启动"
  PORT="$PORT" nohup node "$INSTALL_DIR/server/index.mjs" > "$INSTALL_DIR/server.log" 2>&1 &
  sleep 2
  ok "PID $!"
  warn "未装 systemd，重启后不会自启"
fi

# ── 健康检查 ───────────────────────────────────────
step "健康检查"
HEALTH="http://127.0.0.1:$PORT/api/health"
for i in 1 2 3 4 5; do
  if curl -fsS "$HEALTH" >/dev/null 2>&1; then
    ok "服务响应正常"
    # 光看 /api/health 会漏判：它不依赖 dist。工作目录不对时健康检查照样绿，
    # 首页却是 "dist not found" —— 这个坑在 Windows 那边踩过一次。
    if curl -fsS "http://127.0.0.1:$PORT/" 2>/dev/null | grep -q 'id="root"'; then
      ok "首页 HTML 正常（dist 可读，工作目录正确）"
    else
      warn "首页取不到，或响应里没有 #root —— 检查 systemd 的 WorkingDirectory 是不是 $INSTALL_DIR"
    fi
    break
  fi
  [[ $i -eq 5 ]] && { echo "  服务没起来"; [[ "$HAS_SYSTEMD" == "1" ]] && sudo journalctl -u "$SERVICE_NAME" -n 20 --no-pager; exit 1; }
  sleep 1
done

# ── Tailscale HTTPS ────────────────────────────────
if [[ "$DO_TAILSCALE" == "1" ]] && command -v tailscale >/dev/null; then
  step "配置 Tailscale HTTPS"
  TS_NAME="$(tailscale status --json 2>/dev/null | grep -o '"DNSName":"[^"]*' | head -1 | cut -d'"' -f4)"
  if [[ -z "$TS_NAME" ]]; then
    warn "拿不到本机域名，跳过"
  else
    tailscale serve --bg "$PORT" 2>&1 | sed 's/^/  /'
    ok "HTTPS 地址：https://${TS_NAME%/}/"
    echo
    echo "  ${B}手机/平板怎么用：${N}"
    echo "    1. 装 Tailscale 并登录同一账号"
    echo "    2. 浏览器打开 https://${TS_NAME%/}/"
    echo "    3. 菜单「添加到主屏幕」即可当 App 用"
  fi
fi

# ── 完成 ───────────────────────────────────────────
HOST_IP="$(hostname -I 2>/dev/null | awk '{print $1}')"
cat <<EOF

${B}${G}部署完成${N}

  本机      http://127.0.0.1:$PORT
  局域网    http://${HOST_IP:-<本机IP>}:$PORT
  数据目录  $INSTALL_DIR/data

${B}下一步：装插件${N}
  在网页里进「设置 → 内容源插件 → 导入」，选一个 .json 插件文件。
  装完白名单会自动生效，不需要改任何配置。

${B}常用命令${N}
$( [[ "$HAS_SYSTEMD" == "1" ]] && echo "  看日志    journalctl -u $SERVICE_NAME -f" && echo "  重启      sudo systemctl restart $SERVICE_NAME" && echo "  停止      sudo systemctl stop $SERVICE_NAME" )
  看状态    curl http://127.0.0.1:$PORT/api/health

EOF

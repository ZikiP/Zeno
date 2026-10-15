# 部署到 MiniPC + Tailscale

一套服务跑在自己的机器上，手机平板通过 Tailscale 访问，书架/进度/书签/插件/偏好自动同步。

## 架构

```
手机 / 平板 / 电脑
        │  Tailscale（WireGuard 加密）
        │  https://<机器名>.<tailnet>.ts.net
        ▼
┌─────────────────────────────────────┐
│ MiniPC                              │
│  node server/index.mjs              │
│    ├── /                静态文件    │
│    ├── /api/sync/*      同步        │
│    ├── /api/proxy       抓取代理    │
│    └── /api/health      状态        │
│         ↓                           │
│  data/zeno.db   SQLite（Node 内置）  │
└─────────────────────────────────────┘
```

**一个进程做三件事**，MiniPC 上不用跑多个服务、只开一个端口。

## 前置条件

| 项 | 说明 |
|---|---|
| Node ≥ 22.5 | 用内置的 `node:sqlite`，**不需要编译原生模块** |
| Tailscale | 所有设备登录同一个账号 |
| MagicDNS + HTTPS 证书 | Tailscale 管理后台开启（新建 tailnet 默认开） |

## 部署步骤

### 1. 拉代码 + 构建

```bash
git clone https://github.com/ZikiP/Zeno.git
cd Zeno
npm install
```

### 2. 启动

```bash
npm run serve
```

`serve` = `npm run build && node server/index.mjs`。**就这一条命令。**

启动后会打印：

```
  Zeno 服务已启动
  ├─ 本机      http://127.0.0.1:8788
  ├─ 局域网    http://192.168.x.x:8788
  ├─ 静态目录  .../dist
  ├─ 数据库    ./data/zeno.db
  ├─ 抓取白名单 空 — 装个插件就会自动放行对应站点
  └─ 同步令牌  未设置（仅靠 tailnet 保护）
```

### 3. 装个插件

浏览器打开后进「设置 → 内容源插件」，导入一个 `.json` 插件文件。

**装完自动放行** —— 服务端会从插件配置里读出 `entry` / `chapterHost` / `imageHosts`，
写进代理白名单。不用改环境变量，不用重启。

白名单当前状态可以随时查：

```bash
curl http://127.0.0.1:8788/api/health
# 返回里的 allowedHosts 就是当前放行的域名
```

### 4. 用 Tailscale 暴露 HTTPS

```bash
tailscale serve --bg 8788
```

输出形如：

```
Available within your tailnet:
https:// your-mini-pc.your-tailnet.ts.net/
```

**这一步不能省。** 直接用 `http://机器名:8788` 虽然能通，但浏览器不认那是「安全上下文」，
Service Worker 不工作，PWA 的离线能力会静默失效。

### 5. 设备上访问

手机/平板装 Tailscale、登录同一账号，浏览器打开上面的 `https://xxx.ts.net` 即可。

- 安卓：菜单「添加到主屏幕」当 App 用
- iOS：Safari 分享 →「添加到主屏幕」

**同步是零配置的** —— 同源部署时前端默认连当前地址，打开就同步。

## ⚠️ Tailscale 常见坑

| 现象 | 原因 | 解法 |
|---|---|---|
| Android 上 `*.ts.net` 解析失败 | 私人 DNS 冲突 | 设置 → 网络 → 私人 DNS 设为「自动」或「关闭」 |
| Chrome 里解析不了 | Chrome 的安全 DNS 绕过 MagicDNS | `chrome://settings/security` 关掉「使用安全 DNS」 |
| iOS 上装成 App 后收不到推送 | Safari 标签页无法收推送 | 必须从主屏幕图标启动，且与网站同源 |
| 在外面访问很卡 | 国内对称 NAT，UDP 打洞失败 | 见下方「在外网访问」 |

### 在外网（用流量）访问

能访问，但路径会变：

| 场景 | 路径 | 延迟 |
|---|---|---|
| 在家 / 同一网络 | P2P 直连 | 20-30ms |
| 在外 / 蜂窝网络 | 打洞失败 → DERP 中继（最近在香港） | 200-300ms |

先确认自己走的是哪条路：

```bash
tailscale status    # 看 relay 那列：direct=直连，derpX=中继
tailscale netcheck  # MappingVariesByDestIP: true 说明是对称 NAT
```

**真正要操心的是流量**：一话 3-15 MB，看一小时 100-400 MB。

三个缓解手段，按性价比排：

1. **出门前离线下载**（零成本，最有效）—— 详情页「离线下载」，之后完全不耗流量
2. **路由器开 UPnP 或静态映射 UDP 41641**（免费）—— 把 NAT 从对称降级为全锥，打洞成功率大幅提升
3. **自建 DERP 中继**（约 8 元/月）—— 国内 VPS 上跑一个，实测延迟 148ms → 38ms

PWA 本身有 CacheFirst 缓存，**看过的章节第二次不费流量**。

## 数据备份

全部数据在三个文件里：

```
data/zeno.db          主库
data/zeno.db-wal      WAL 日志
data/zeno.db-shm      共享内存
```

停服后复制 `data/` 整个目录即可。运行中备份要用
`sqlite3 data/zeno.db ".backup backup.db"`（WAL 模式下直接拷文件可能拿到不一致快照）。

**插件配置也在这里** —— 备份丢了就得重新导入插件。

## 安全边界

只靠 Tailscale 的 tailnet 隔离：**不在 tailnet 里的设备根本连不上**。

需要更强隔离时设置 `SYNC_TOKEN`：

```bash
SYNC_TOKEN=你的随机长字符串 npm start
```

然后在各设备「设置 → 多端同步」里填同一个令牌。

**不要用 `tailscale funnel`** —— 那会把服务暴露到公网，与「只给自己用」的目的相反。

抓取代理有白名单保护，不会变成开放代理。白名单来自已安装的插件，
不装插件就没有任何域名被放行。

## 环境变量（全部可选）

一个都不设也能正常用。要改行为时才需要：

| 变量 | 默认 | 说明 |
|---|---|---|
| `PORT` | 8788 | 监听端口 |
| `DIST_DIR` | `./dist` | 静态文件目录 |
| `DB_PATH` | `./data/zeno.db` | 数据库位置 |
| `ALLOWED_HOSTS` | 空 | 手动补充白名单。**装插件就自动放行了，通常不用设** |
| `MAX_CONCURRENT` | 6 | 上游并发上限 |
| `SYNC_TOKEN` | 空 | 设置后同步 API 需要 `Authorization: Bearer <token>` |

## 开机自启

### systemd（Linux）

```ini
# /etc/systemd/system/zeno.service
[Unit]
Description=Zeno
After=network-online.target tailscaled.service
Wants=network-online.target

[Service]
Type=simple
WorkingDirectory=/opt/Zeno
Environment=PORT=8788
ExecStart=/usr/bin/node /opt/Zeno/server/index.mjs
# on-failure 而不是 always —— 否则手动 systemctl stop 之后它会自己爬起来
Restart=on-failure
RestartSec=5
StandardOutput=journal
StandardError=journal
SyslogIdentifier=zeno

[Install]
WantedBy=multi-user.target
```

`ExecStart` 直接给 `node server/index.mjs`，别写 `npm run serve` —— 那个脚本每次
开机都要重跑一遍构建，常驻服务不该依赖构建链。`WorkingDirectory` 必须有，
`DIST_DIR` / `DB_PATH` 默认是相对 cwd 的。

```bash
systemctl enable --now zeno
journalctl -u zeno -f
```

不用设任何环境变量 —— 白名单会从插件数据库自动读。

### 计划任务（Windows）

优先用 `.\deploy.ps1`，它已经把下面这些坑都处理了。真要手写，注意三件事：

- **`/tr "npm run serve"` 不行**：Task Scheduler 起的进程 cwd 是 `C:\Windows\System32`，
  而且默认不落 stdout。要包一层脚本先 `Set-Location` 到安装目录、再把输出重定向到
  **安装目录里**的日志文件（`%TEMP%` 写不进去，SYSTEM 不是你的用户）。
- **`/ru SYSTEM` 起不了浏览器**：插件里写 `fetch.mode="browser"` 的话，SYSTEM（会话 0）
  下 Edge 会以 `exitCode=1002` 直接退出。用 `-RunAsUser`（S4U）或 `/ru` 换成你的账号。
- 崩溃自动重启要显式配，`schtasks` 本身不给，得用 `New-ScheduledTaskSettingsSet -RestartCount`。

```powershell
.\deploy.ps1 -RunAsUser          # 推荐
.\deploy.ps1 -RunAsUser -SkipInstall   # 依赖和 dist 已是新的，只重注册任务
```

### Docker

容器里没有 chromium 系浏览器，`fetch.mode="browser"` 的插件会一直 503；
要用就在镜像里装一个并设 `ZENO_BROWSER`。纯 `fetch` 模式的插件不受影响。

```dockerfile
FROM node:22-slim
WORKDIR /app
COPY package*.json ./
RUN npm ci
COPY . .
RUN npm run build
ENV PORT=8788
EXPOSE 8788
VOLUME /app/data
CMD ["node", "server/index.mjs"]
```

`/app/data` 要挂卷，否则重启丢数据。

## 验证

```bash
npm test                              # 同步 API + 多端往返
node scripts/verify-plugin.ts <插件>   # 插件解析
curl http://127.0.0.1:8788/api/health # 状态 + 当前白名单
```


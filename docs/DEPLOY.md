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
npm ci
npm run build
```

### 2. 启动服务

```bash
ALLOWED_HOSTS=你的站点域名,图片CDN域名 node server/index.mjs
```

环境变量：

| 变量 | 默认 | 说明 |
|---|---|---|
| `PORT` | 8788 | 监听端口 |
| `DIST_DIR` | `./dist` | 静态文件目录 |
| `DB_PATH` | `./data/zeno.db` | 数据库位置 |
| `ALLOWED_HOSTS` | 空 | 抓取代理白名单，**不设置则拒绝一切** |
| `MAX_CONCURRENT` | 6 | 上游并发上限 |
| `SYNC_TOKEN` | 空 | 设置后同步 API 需要 `Authorization: Bearer <token>` |

`ALLOWED_HOSTS` 填你要访问的站点与它的图片 CDN。插件编辑器里会自动算出该填什么。

### 3. 用 Tailscale 暴露 HTTPS

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

### 4. 设备上访问

手机/平板装 Tailscale、登录同一账号，浏览器打开上面的 `https://xxx.ts.net` 即可。

- 安卓：菜单「添加到主屏幕」当 App 用
- iOS：Safari 分享 →「添加到主屏幕」

### 5. 配同步

**同源部署时什么都不用填** —— 前端默认连当前地址，打开就同步。

要在设置里填地址的情况：前端单独部署、或者要给多台后端做区分。

## ⚠️ Tailscale 常见坑

| 现象 | 原因 | 解法 |
|---|---|---|
| Android 上 `*.ts.net` 解析失败 | 私人 DNS 冲突 | 设置 → 网络 → 私人 DNS 设为「自动」或「关闭」 |
| Chrome 里解析不了 | Chrome 的安全 DNS 绕过 MagicDNS | `chrome://settings/security` 关掉「使用安全 DNS」 |
| iOS 上装成 App 后收不到推送 | Safari 标签页无法收推送 | 必须从主屏幕图标启动，且与网站同源 |
| 服务跑着跑着全 502 | 服务崩了 | 现在有全局兜底不会崩；看日志确认端口没被占 |

## 数据同步说明

### 同步什么

| 数据 | 说明 |
|---|---|
| 书架 | 集合式合并 |
| 阅读进度 | 每章一个百分比 |
| 读到哪一章 | |
| 书签与笔记 | 可写笔记 |
| 插件配置 | 整机一份 |
| 主题 / 阅读偏好 | |

**不同步图片缓存** —— 太大了，整部漫画几个 GB，且手机在外网时拉不动。

### 冲突怎么解决

全部按「`updated_at` 大的胜」。简单，且满足两条性质：

- **幂等**：同样数据推多次结果不变
- **可交换**：A→B、B→A 结果一致，不会来回震荡

时钟不准只会让「最近写的赢」，不会丢数据。

一个特判：**已读完的章节（100%）不会被小值覆盖** —— 平板上读完了，手机上误操作拖回去不会把它标成未读。

### 什么时候同步

- 打开页面时
- 页面重新可见时（手机切后台回来，定时器被浏览器冻结了，所以用 `visibilitychange`）
- 恢复联网时
- 每 5 分钟

**服务端不可达不影响本地功能**，只是这次没同步上，下次补。

## 安全边界

只靠 Tailscale 的 tailnet 隔离：**不在 tailnet 里的设备根本连不上**。

需要更强隔离时设置 `SYNC_TOKEN`：

```bash
SYNC_TOKEN=你的随机长字符串 ALLOWED_HOSTS=... node server/index.mjs
```

然后在各设备设置页的「多端同步」里填同一个令牌。

**不要用 `tailscale funnel`** —— 那会把服务暴露到公网，与「只给自己用」的目的相反。

## 数据备份

全部数据在一个文件里：

```
data/zeno.db          主库
data/zeno.db-wal      WAL 日志
data/zeno.db-shm      共享内存
```

直接复制这三个文件即可备份。也可以停服后只拷 `.db`。

## 开机自启

### systemd（Linux）

```ini
# /etc/systemd/system/zeno.service
[Unit]
Description=Zeno
After=network-online.target tailscaled.service

[Service]
WorkingDirectory=/opt/Zeno
Environment=ALLOWED_HOSTS=example.com,cdn.example.com
ExecStart=/usr/bin/node server/index.mjs
Restart=always

[Install]
WantedBy=multi-user.target
```

```bash
systemctl enable --now zeno
```

### 计划任务（Windows）

```bat
schtasks /create /tn Zeno /tr "node D:\Zeno\server\index.mjs" /sc onstart /ru SYSTEM
```

## 验证

```bash
# 服务健康
curl http://127.0.0.1:8788/api/health

# 同步往返（含冲突、幂等、读完保护）
node scripts/test-sync.mjs

# 模拟第二台设备写入
node scripts/test-multidevice.mjs
```

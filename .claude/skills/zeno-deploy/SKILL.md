---
name: zeno-deploy
description: 在 Windows / Linux / macOS 上部署 Zeno（干净的网页阅读器）并配成开机自启的常驻服务。当用户要部署、发布、上线、放到 NAS/迷你主机/服务器上，或要配置 Tailscale HTTPS 访问时使用。也适用于排查已部署实例的启动失败、端口占用、证书签发失败等问题。
---

# Zeno 部署

## Zeno 是什么

跨端 PWA 网页阅读器。三端（手机/平板/桌面）共用一个服务端，通过 Tailscale
安全访问，数据（书架、阅读进度、书签、插件、偏好）多端同步。

**Node 22+ 是硬要求** —— 用到内置的 `node:sqlite`，不需要编译原生模块。

## 最重要的一条：白名单不用配

抓取代理的白名单**从已安装的插件自动推导**。装好插件服务端立刻放行对应站点。

看到有人填 `ALLOWED_HOSTS` 就要拦下来 —— 那是旧版设计，现在不需要了，
填了反而会造成「插件改了域名但白名单没跟着变」。

## 部署

### 自动（推荐）

仓库根目录带了一键脚本，能直接用就先试：

| 平台 | 命令 |
|---|---|
| Linux / macOS | `./deploy.sh` |
| Windows | `.\deploy.ps1` |

脚本做的事：环境检查 → `npm ci` → `npm run build` → 注册开机自启 →
健康检查 → 配 Tailscale HTTPS。

脚本已经处理了代理问题：配 Serve 前会清掉 `http_proxy`/`https_proxy`。

### 手动（脚本跑不通时）

```bash
git clone https://github.com/ZikiP/Zeno.git
cd Zeno
npm install
npm run build
node server/index.mjs          # 前台跑，先确认能起来
```

确认没问题再配常驻。

### Linux 常驻

`deploy.sh` 会写 `/etc/systemd/system/zeno.service`，内容要点：

```ini
[Unit]
After=network-online.target tailscaled.service

[Service]
WorkingDirectory=<安装目录>
Environment=PORT=8788
ExecStart=/usr/bin/node server/index.mjs
Restart=on-failure
RestartSec=5

[Install]
WantedBy=multi-user.target
```

```bash
sudo systemctl daemon-reload
sudo systemctl enable --now zeno
journalctl -u zeno -f
```

**用 `Restart=on-failure` 而不是 `always`** —— 否则手动 `systemctl stop` 之后
它会自己爬起来，行为不符合直觉。

### Windows 常驻

`deploy.ps1` 用**计划任务**而不是 Windows 服务：

- 触发器：开机（延迟 10 秒，等网络起来）
- 账号：`NT AUTHORITY\SYSTEM`（不需要登录，开机就在）
- 设置：`RestartCount 999` + `RestartInterval 1min`，`ExecutionTimeLimit` 无限

```powershell
.\deploy.ps1
Get-Content "$env:TEMP\zeno.log" -Tail 20 -Wait
Restart-ScheduledTask -TaskName Zeno
Stop-ScheduledTask   -TaskName Zeno
```

**为什么不装 Windows 服务**：需要额外的包装器（nssm/winsw）。
计划任务用 SYSTEM 账号 + 自动重启，行为和 systemd 等价，零额外依赖。

**计划任务默认不落 stdout**，所以必须包一层 wrapper 把输出重定向到文件：

```powershell
& 'C:\path\to\node.exe' 'C:\path\Zeno\server\index.mjs' *>> "$env:TEMP\zeno.log"
```

不这么做的话，崩溃后连日志都看不到。

### Windows 脚本编写注意

- **PowerShell 5.1 不支持 `??` 和 `?.` 运算符**（那是 PS7 的）。
  用 `if` 判断代替，否则脚本在 5.1 上直接语法错误。
- `New-ScheduledTaskTrigger` 返回的对象**不能直接改 Delay**，
  要先接住再赋值：`$trigger = New-ScheduledTaskTrigger -AtStartup; $trigger.Delay = 'PT10S'`
- **`Set-Location` 在某些执行环境下不跨调用保持**，写文件用绝对路径。

## Tailscale HTTPS

### 为什么必须用它

**不能直接用 `http://机器名:端口`。** 那样虽然能通（WireGuard 本身加密），
但浏览器不认那是「安全上下文」，Service Worker 不注册，**PWA 离线能力静默失效**。

用户会看到「装成 App 了但断网就打不开」，且极难排查。

### 步骤

```bash
tailscale serve --bg 8788
```

拿到 `https://<机器名>.<tailnet>.ts.net`。

### ⚠️ 最大的坑：代理会搞挂证书签发

如果系统跑着代理（Clash / FlClash / V2Ray / 公司代理），且环境变量里有
`http_proxy` / `https_proxy`，**Tailscale 签证书的请求会被代理接管**，
证书签不下来，症状是：

```
TCP 通，TLS 握手被服务端拒绝
curl: (35) schannel: InitializeSecurityContext failed: SEC_E_INTERNAL_ERROR
浏览器: ERR_SSL_PROTOCOL_ERROR
tailscale netcheck 输出: tshttpproxy: using proxy ...
```

**解法：配 Serve 之前先清掉代理环境变量。**

```bash
# Linux / macOS
env -u http_proxy -u https_proxy tailscale serve --bg 8788

# PowerShell
$env:http_proxy=''; $env:https_proxy=''
tailscale serve --bg 8788
```

> 实测：Windows 上开着 FlClash 时，`tailscale netcheck` 输出
> `tshttpproxy: using proxy "http://127.0.0.1:60887"`，
> TCP 443 通但 TLS 握手被拒（`SEC_E_INTERNAL_ERROR` / `ERR_SSL_PROTOCOL_ERROR`）。
> 关掉代理重新配 Serve，1 秒内恢复，200 OK。

长期解法是在代理软件里排除：

```
DOMAIN-SUFFIX,ts.net,DIRECT
DOMAIN-SUFFIX,tailscale.com,DIRECT
PROCESS-NAME,tailscaled.exe,DIRECT
PROCESS-NAME,tailscale-ipn.exe,DIRECT
```

**只排除服务端的还不够** —— 客户端（手机）也得能直连，
否则手机照样走代理，证书校验失败。

顺带一个佐证：国内跑 Tailscale 时 `netcheck` 若显示
`Nearest DERP: San Francisco` 而香港延迟更高，说明流量被代理绕了一圈。

### 诊断命令

```bash
tailscale serve status        # 规则配了没
tailscale netcheck            # 有没有被代理（看 tshttpproxy 那行）
curl -v https://<name>.<tailnet>.ts.net/api/health
```

## 排查手册

| 现象 | 根因 | 处理 |
|---|---|---|
| `MCP error` / 进程秒退 | 看日志 | `journalctl -u zeno -n 50` 或 `%TEMP%\zeno.log` |
| 端口占用 | 上次没退干净 | `ss -ltnp \| grep 8788`；Windows 用 `Get-NetTCPConnection -LocalPort 8788` |
| 改了端口不生效 | 环境变量没传到服务 | Linux 改 systemd 的 `Environment=`；Windows 改 wrapper |
| 打开是 404 | dist 没构建 | `npm run build` |
| 深链接白屏 | SPA 回退没配 | 确认用的是内置 `server/index.mjs`，不是裸静态服务器 |
| 抓不到图（403） | 白名单没生效 | `/api/health` 看 `allowedHosts`；确认插件已装 |
| 手机装不了 PWA | 用的 http | 必须 https |
| 证书签发失败 | 代理劫持 | 清 `http_proxy`/`https_proxy` 再配 Serve |
| `*.ts.net` 解析失败（安卓） | 私人 DNS 冲突 | 设置 → 网络 → 私人 DNS 设为「自动」或「关闭」 |
| Chrome 里解析不了 | Chrome 安全 DNS 绕过 MagicDNS | `chrome://settings/security` 关掉「使用安全 DNS」 |
| 数据丢了 | 删了 `data/` | 数据全在 `data/zeno.db`，备份就是拷这个文件 |

## 数据

```
data/zeno.db         主库（WAL 模式）
data/zeno.db-wal     WAL 日志
data/zeno.db-shm     共享内存
```

**插件配置也在里面。** 换机器时拷 `data/` 目录即可。

运行中备份要用 `.backup`，直接拷文件可能拿到不一致快照：

```bash
sqlite3 data/zeno.db ".backup /path/backup.db"
```

## 安全

- 只靠 Tailscale 的 tailnet 隔离，不在网内根本连不上
- 要更强隔离就设 `SYNC_TOKEN`，各设备设置页填同一个令牌
- **绝不要用 `tailscale funnel`** —— 那会暴露到公网，与「只给自己用」相反
- 抓取代理有白名单，不装插件就没有任何域名被放行

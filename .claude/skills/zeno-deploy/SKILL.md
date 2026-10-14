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

## 抓取代理有两道闸，别为了"能抓"去拆掉第二道

1. **域名白名单** —— 从已装插件自动推导。
2. **地址策略（`server/ssrf.mjs`）** —— 目标解析出的 IP 必须是公网可路由地址。

第二道是防 SSRF 的：白名单只挡"哪些域名"，挡不住"域名解析到哪"。装一个
`entry` 填 `http://127.0.0.1` 或 `http://169.254.169.254/` 的插件，就能让
服务端替你去够内网和云元数据接口。所以回环、RFC1918、链路本地、
`100.64.0.0/10`（Tailscale 段，含服务自己）、组播、保留段全部拒绝。

上游回 3xx 时代理**逐跳自己跟、逐跳重新校验**。看到 `redirect: 'follow'`
出现在这里就是漏洞 —— 白名单域名回一个 `302 → http://127.0.0.1` 能绕过两道闸。

`ALLOW_PRIVATE_HOSTS=1` 只为本地测试存在（白名单套件的假源站跑在 127.0.0.1）。
**生产环境开它等于关掉这道闸。**

残留风险要如实说：校验是"先解析再请求"，两次解析之间 DNS 可以换记录
（rebinding）。彻底闭环需要在建连时再校验一次，而 Node 全局 `fetch` 不暴露
那个钩子。当前威胁模型是"别人分享的插件文件"，按这个尺度是合适的强度。

## fetch.mode："browser"

默认 `fetch` 是 Node 直接 HTTP 取 HTML，拿不到 JS 渲染的内容。插件写
`"fetch": { "mode": "browser", "waitFor": "<选择器>" }` 会让服务端用真的浏览器
引擎渲染后取 DOM。

- 只作用于 HTML 文档；**图片永远走 fetch**
- 慢（1–3s/页）、失败只试一次、响应 `no-store`
- 需要服务端有 chromium 系浏览器：`ZENO_BROWSER` → ms-playwright 缓存 → Edge → Chrome
- **不含任何反自动化伪装**（不改 `navigator.webdriver`、不伪造指纹、不破解质询
  令牌）。它的定位是渲染 JS 页面，不是冒充人类绕过机器人拦截。站点若拒绝
  自动化客户端，就应该被拒绝 —— 部署脚本找不到浏览器也只警告，不硬失败

## 部署

### 自动（推荐）

仓库根目录带了一键脚本，能直接用就先试：

| 平台 | 命令 |
|---|---|
| Linux / macOS | `./deploy.sh` |
| Windows | `.\deploy.ps1` |

脚本做的事：环境检查 → `npm ci` → `npm run build` → 注册开机自启 →
健康检查 → 配 Tailscale HTTPS。

Windows 上脚本会**读注册表里的真实代理状态**并检查绕过列表，缺 `*.ts.net`
就明确报出来。它不会去清 `$env:http_proxy` —— 那是空操作，见下文。

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
Get-Content "<安装目录>\zeno.log" -Tail 20 -Wait
Restart-ScheduledTask -TaskName Zeno
Stop-ScheduledTask   -TaskName Zeno
```

**为什么不装 Windows 服务**：需要额外的包装器（nssm/winsw）。
计划任务用 SYSTEM 账号 + 自动重启，行为和 systemd 等价，零额外依赖。

**计划任务默认不落 stdout**，所以必须包一层 wrapper 把输出重定向到文件：

```powershell
& 'C:\path\to\node.exe' 'C:\path\Zeno\server\index.mjs' *>> 'C:\path\Zeno\zeno.log'
```

**日志别放 `%TEMP%`**：任务以 `NT AUTHORITY\SYSTEM` 运行，写不进普通用户的
`%TEMP%`，而且重定向失败会被 `$ErrorActionPreference='Continue'` 吞掉，
结果就是「服务挂了却一行日志都没有」。放安装目录，SYSTEM 有权限，路径也固定。

同理，包装脚本**必须先 `Set-Location` 到安装目录**（或直接给 `DIST_DIR` /
`DB_PATH` 绝对路径）。Task Scheduler 启动的 PowerShell 默认 cwd 是
`C:\Windows\System32`，而 `server/index.mjs` 里这两个路径都是 `resolve('./...')`
—— 不钉死的话，服务会在 System32 下建库，并且根路径一直返回 `dist not found`。

不这么做的话，崩溃后连日志都看不到。

### Windows 脚本编写注意

- **PowerShell 5.1 不支持 `??` 和 `?.` 运算符**（那是 PS7 的）。
  用 `if` 判断代替，否则脚本在 5.1 上直接语法错误。
- `New-ScheduledTaskTrigger` 返回的对象**不能直接改 Delay**，
  要先接住再赋值：`$trigger = New-ScheduledTaskTrigger -AtStartup; $trigger.Delay = 'PT10S'`
- **`Set-Location` 在某些执行环境下不跨调用保持**，写文件用绝对路径。

## Tailscale HTTPS

### 为什么必须用它

**不能直接用 `http://局域网IP:端口` 或 `http://机器名:端口`。** 那样虽然能通
（WireGuard 本身加密），但浏览器不认那是「安全上下文」，Service Worker 不注册，
**PWA 离线能力静默失效**。

用户会看到「装成 App 了但断网就打不开」，且极难排查。

**但回环地址是例外。** `http://127.0.0.1:端口` 和 `http://localhost:端口`
本身就是安全上下文，Service Worker 正常注册。实测：

```
http://127.0.0.1:8788  →  isSecureContext: true, swRegistered: true
```

所以**在本机看效果、做开发，直接开 `127.0.0.1` 就行，不需要先配 HTTPS**。
Serve 是为了手机/平板这些真正要走网络的客户端。

### 步骤

```bash
tailscale serve --bg 8788
```

拿到 `https://<机器名>.<tailnet>.ts.net`。

### ⚠️ 最大的坑：系统代理会掐断 ts.net 的 TLS

**先说结论：Windows 上代理状态不在环境变量里，在注册表里。**
清 `$env:http_proxy` 是空操作 —— 那个变量通常根本没被设过。

Clash / FlClash / V2Ray 开「系统代理」时写的是
`HKCU\Software\Microsoft\Windows\CurrentVersion\Internet Settings`：

```
ProxyEnable   = 1
ProxyServer   = 127.0.0.1:7890      # 端口随客户端和版本变，别硬编码
ProxyOverride = <绕过列表>           # 这里没有 *.ts.net 就会坏
```

浏览器和 `tailscale-ipn.exe` 读的是这个，**不是 env**。

**故障点不在证书签发，在客户端那一跳。** Serve 和证书都是好的 ——
实测绕开代理直连 `https://<name>.ts.net/api/health` 稳定 200、`ssl_verify=0`。
是浏览器把 `*.ts.net` 的请求塞进了代理，代理建完 CONNECT 隧道后 TLS 握手被中断：

```
> CONNECT <name>.ts.net:443 HTTP/1.1
< HTTP/1.1 200 Connection established     ← TCP 和隧道都"成功"
* Recv failure: Connection was aborted    ← 握手死在这
浏览器: ERR_CONNECTION_ABORTED / ERR_SSL_PROTOCOL_ERROR
curl:   (35) schannel: failed to receive handshake
```

根因：`ts.net` 只有 MagicDNS 能解析，代理拿不到正确地址。

### 解法：把 `*.ts.net` 加进代理的绕过列表

**改代理软件自己的「绕过 / 直连」设置，不要直接改注册表。**
Clash 系客户端在开关系统代理时**整个重写 `ProxyOverride`**，手改会被静默覆盖，
表现为"昨天还能访问今天又不行了"。

加 `*.ts.net` 一条就够（实测：代理保持开启，加完立刻 200，Chrome 无需重启）。
不需要 `100.*` —— 那是整个 `/8`，比 tailnet 的 `100.64.0.0/10` 宽得多，
而且 tailnet 走的是 `/32` 主机路由，本来就比代理的默认路由精确。

**也别指望 Clash 规则**：`DOMAIN-SUFFIX,ts.net,DIRECT` 不可靠，
因为流量仍然进了代理，代理解析不了 `ts.net`；fake-ip 模式下它给的是
不可路由的假地址。要修的是"别进代理"，不是"进代理后怎么路由"。

**服务端和每台客户端都要各配一遍** —— 手机上开着代理的话同样要绕过 `*.ts.net`。

改完注册表想让正在跑的浏览器立刻生效，得广播设置变更通知
（直接写注册表不会触发，代理软件自己会做这件事）：

```powershell
$sig='[DllImport("wininet.dll",SetLastError=true)] public static extern bool InternetSetOption(IntPtr h,int o,IntPtr b,int l);'
$w=Add-Type -MemberDefinition $sig -Name W -Namespace Net -PassThru
[void]$w::InternetSetOption([IntPtr]::Zero,39,[IntPtr]::Zero,0)   # SETTINGS_CHANGED
[void]$w::InternetSetOption([IntPtr]::Zero,37,[IntPtr]::Zero,0)   # REFRESH
```

Linux / macOS 上代理才走 env，那时这个写法是对的：

```bash
env -u http_proxy -u https_proxy tailscale serve --bg 8788
```

顺带一个佐证：国内跑 Tailscale 时 `netcheck` 若显示
`Nearest DERP: San Francisco` 而香港延迟更高，说明流量被代理绕了一圈。


### 诊断命令

```bash
tailscale serve status        # 规则配了没
tailscale serve ip forward    # （一般不需要）
```

判断是不是代理的锅，**用这一组**，别信 `netcheck`：

```bash
# Windows 上 netcheck 不打印 tshttpproxy，用它定位代理状态没有用。
# 直接读注册表，再对比走代理 / 不走代理两个结果：
powershell -c "(Get-ItemProperty 'HKCU:\Software\Microsoft\Windows\CurrentVersion\Internet Settings') |
  Select ProxyEnable,ProxyServer,ProxyOverride | Format-List"

curl -s --noproxy '*' -o NUL -w 'direct  %{http_code}\n' https://<name>.ts.net/api/health
curl -s            -o NUL -w 'proxied %{http_code}\n' \
     -x http://127.0.0.1:7890 https://<name>.ts.net/api/health
```

直连 200 而 proxied 失败（curl 35）→ 就是绕过列表缺 `*.ts.net`。
这个组合还能顺手证明「证书和 Serve 本身是好的」，排除一大类误判。

**浏览器里最省事的判据**（能识破 precache 假阳性）：

```js
fetch('/api/health', { cache: 'no-store' }).then(r => r.status)
```

页面看着完好但这里 reject → 网络层是断的，别去看 UI。

## 排查手册

| 现象 | 根因 | 处理 |
|---|---|---|
| `MCP error` / 进程秒退 | 看日志 | `journalctl -u zeno -n 50` 或 `<安装目录>\zeno.log` |
| 健康检查绿但页面是 `dist not found` | 服务 cwd 不是安装目录 | 包装脚本里 `Set-Location`，或看 `/api/health` 的 `dbPath` 落在哪 |
| 端口占用 | 上次没退干净 | `ss -ltnp \| grep 8788`；Windows 用 `Get-NetTCPConnection -LocalPort 8788` |
| 改了端口不生效 | 环境变量没传到服务 | Linux 改 systemd 的 `Environment=`；Windows 改 wrapper |
| 打开是 404 | dist 没构建 | `npm run build` |
| 深链接白屏 | SPA 回退没配 | 确认用的是内置 `server/index.mjs`，不是裸静态服务器 |
| 抓不到图（403） | 白名单没生效 | `/api/health` 看 `allowedHosts`；确认插件已装 |
| 403 且 `error:"blocked address"` | 目标解析到内网/回环/元数据/CGNAT 段 | 正常拦截，别去关它；本地测试才设 `ALLOW_PRIVATE_HOSTS=1` |
| 503 且提示没有可用浏览器 | 插件用了 `fetch.mode:"browser"` 但服务端没 chromium 系浏览器 | 装 Chrome/Edge，或设 `ZENO_BROWSER`；部署脚本的环境检查会报这个 |
| 502 + `browserType.launch: ... browser has been closed`，Edge `exitCode=1002` | 服务以 **SYSTEM**（会话 0）常驻，浏览器起不来 | 沙箱不是原因（Playwright 已带 `--no-sandbox`）。要么 `deploy.ps1 -Mode none` 以登录用户前台跑，要么把计划任务主体换成用户账号。常驻与 browser 渲染目前不可兼得 |
| 列表/详情解析出 0 条但页面在浏览器里正常 | 站点内容靠 JS 注入，`fetch` 模式拿到的是空壳 | 插件加 `"fetch": { "mode": "browser", "waitFor": "<卡片选择器>" }` |
| 手机装不了 PWA | 用的 http（**`127.0.0.1` 除外**） | 局域网 IP / 机器名必须 https |
| 页面渲染正常但什么都不加载 | 系统代理掐断 ts.net，Workbox 用 precache 兜住了导航 | 见下「代理劫持」；用 `fetch('/api/health',{cache:'no-store'})` 一测就露 |
| `ERR_CONNECTION_ABORTED` | 代理劫持（**不是**证书没签下来） | 在代理软件的绕过列表里加 `*.ts.net`，改注册表会被覆盖 |
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

<#
.SYNOPSIS
    Zeno 一键部署（Windows）

.DESCRIPTION
    拉代码、构建、注册成开机自启的常驻任务、配 Tailscale HTTPS。

    运行模式：
      auto（默认）  计划任务模式，开机自启 + 崩溃自动重启
      none          仅前台启动，Ctrl+C 退出

.PARAMETER Port
    监听端口，默认 8788

.PARAMETER Mode
    auto | none

.PARAMETER SkipTailscale
    跳过 Tailscale HTTPS 配置

.PARAMETER SkipInstall
    跳过 npm ci 与构建，沿用现有 dist。
    依赖和 dist 已经是新的、只想重注册常驻任务时用这个 ——
    npm ci 会整个删掉重建 node_modules，没必要每次部署都来一遍。

.PARAMETER RunAsUser
    计划任务改用当前登录账号运行（S4U，不需要存密码），而不是 NT AUTHORITY\SYSTEM。

    需要插件用 fetch.mode="browser" 时必须开这个：实测 Edge 在 SYSTEM / 会话 0
    下启动即 exitCode=1002 退出，浏览器渲染根本起不来。
    S4U 仍然是"不管用户是否登录都要运行"，注销后服务继续跑。

.PARAMETER Uninstall
    卸载并清理（数据保留）

.EXAMPLE
    .\deploy.ps1
    .\deploy.ps1 -Port 9000
    .\deploy.ps1 -Uninstall
#>
[CmdletBinding()]
param(
    [int]$Port = 8788,
    [ValidateSet('auto', 'none')]
    [string]$Mode = 'auto',
    [switch]$SkipTailscale,
    [switch]$SkipInstall,
    [switch]$RunAsUser,
    [switch]$Uninstall
)

$ErrorActionPreference = 'Stop'
$ServiceName = 'Zeno'
$InstallDir = Split-Path -Parent $MyInvocation.MyCommand.Path
# 日志必须放在安装目录：任务以 SYSTEM 身份运行，写不进普通用户的 %TEMP%，
# 放那里会静默失败（*>> 报错但 $ErrorActionPreference='Continue' 吞掉），
# 结果就是"服务挂了却一行日志都没有"。
$LogFile = Join-Path $InstallDir 'zeno.log'

function Step($msg) { Write-Host "> $msg" -ForegroundColor Cyan }
function Ok($msg)   { Write-Host "  [OK] $msg" -ForegroundColor Green }
function Warn($msg) { Write-Host "  [!] $msg" -ForegroundColor Yellow }
function Die($msg)  { Write-Host "  [X] $msg" -ForegroundColor Red; exit 1 }

# ── 卸载 ──────────────────────────────────────────
if ($Uninstall) {
    Step '卸载'
    Stop-ScheduledTask -TaskName $ServiceName -ErrorAction SilentlyContinue
    Unregister-ScheduledTask -TaskName $ServiceName -ErrorAction SilentlyContinue
    Ok '计划任务已移除'
    Write-Host "  数据保留在 $InstallDir\data" -ForegroundColor DarkGray
    Write-Host "  连数据一起删：Remove-Item -Recurse -Force '$InstallDir\data'" -ForegroundColor DarkGray
    exit 0
}

# ── 环境检查 ──────────────────────────────────────
Step '检查环境'

$nodeCmd = Get-Command node -ErrorAction SilentlyContinue
if (-not $nodeCmd) { Die '没装 Node.js。装 Node 22+：https://nodejs.org' }
$nodePath = $nodeCmd.Source

$nodeVer = (& node -p 'process.versions.node' 2>$null)
$nodeMajor = [int]($nodeVer -split '\.')[0]
if ($nodeMajor -lt 22) { Die "Node 版本过低（$nodeVer）。需要 22+，因为用到内置的 node:sqlite" }
Ok "Node $nodeVer"

if (-not (Get-Command npm -ErrorAction SilentlyContinue)) { Die '没装 npm' }
Ok ("npm " + (npm -v))

# 渲染浏览器：调用服务端自己的 findBrowser()，避免部署脚本和运行时两套探测逻辑漂移。
# 找不到不算失败 —— 只有 fetch.mode="browser" 的插件需要它，普通插件照常工作。
Step '检查渲染浏览器（可选）'
$env:RENDER_MOD = Join-Path $InstallDir 'server\render.mjs'
$browserCheck = & node --input-type=module -e @'
import { pathToFileURL } from 'node:url';
const m = await import(pathToFileURL(process.env.RENDER_MOD).href);
const b = m.findBrowser();
console.log(b ? 'FOUND|' + b.from + '|' + b.exe : 'NONE');
'@ 2>$null
$browserFound = $false
if ("$browserCheck" -like 'FOUND|*') {
    $parts = "$browserCheck" -split '\|'
    $browserFound = $true
    Ok ("渲染浏览器：" + $parts[2] + "（来源 " + $parts[1] + "）")
} else {
    Warn '没找到 chromium 系浏览器（Chrome / Edge / ms-playwright）。'
    Warn '  不影响普通插件；但插件里写 fetch.mode="browser" 的会报 503。'
    Warn '  装一个 Chrome 或 Edge，或设 ZENO_BROWSER 指向可执行文件。'
}

# ── 更新代码 ──────────────────────────────────────
# 用 git -C 而不是先 Set-Location：Task Scheduler 之类的上下文里 cwd 不一定保持得住。
# 分叉或脏工作副本一律硬停 —— 部署脚本不该替人做"要不要丢改动"这个决定。
Step '更新代码'
if (-not (Get-Command git -ErrorAction SilentlyContinue)) {
    Warn '没装 git，跳过拉取（沿用当前工作副本）'
} elseif (-not (Test-Path (Join-Path $InstallDir '.git'))) {
    Warn '这里不是 git 仓库（大概是解压装的），跳过拉取'
} else {
    if (@(git -C "$InstallDir" status --porcelain).Count -gt 0) {
        Die '工作副本有未提交的改动，不动它。先 commit 或 stash，再部署（git status 看是什么）'
    }
    $before = (git -C "$InstallDir" rev-parse HEAD)
    git -C "$InstallDir" pull --ff-only
    if ($LASTEXITCODE -ne 0) { Die 'git pull --ff-only 没成功（本地和远端分叉了？）。手动处理完再部署' }
    $after = (git -C "$InstallDir" rev-parse HEAD)
    if ($before -ne $after) {
        Ok ("代码已更新 " + $before.Substring(0, 7) + " → " + $after.Substring(0, 7))
    } else {
        Ok '代码已是最新'
    }
}

# ── 依赖与构建 ────────────────────────────────────
Set-Location $InstallDir
if ($SkipInstall) {
    Step '跳过依赖与构建'
    if (-not (Test-Path 'dist')) {
        Die '跳过了构建但 dist 不存在 —— 去掉 -SkipInstall 先完整跑一次'
    }
    Ok '沿用现有 dist'
} else {
    Step '安装依赖'
    if (Test-Path 'package-lock.json') { npm ci } else { npm install }
    # PS 5.1 不会因原生命令非零退出而抛异常，必须自己查 $LASTEXITCODE。
    # 不查的话装挂了也会一路跑到注册任务，起一个没有依赖的常驻服务。
    if ($LASTEXITCODE -ne 0) { Die ("依赖安装失败（exit " + $LASTEXITCODE + "）") }

    Step '构建'
    npm run build
    if ($LASTEXITCODE -ne 0) { Die ('构建失败（exit ' + $LASTEXITCODE + '）') }
    if (-not (Test-Path 'dist')) { Die '构建失败：dist 不存在' }
    Ok '构建完成'
}

# ── 端口检查 ──────────────────────────────────────
Step "检查端口 $Port"
$listener = Get-NetTCPConnection -LocalPort $Port -State Listen -ErrorAction SilentlyContinue
if ($listener) {
    $owner = $listener[0].OwningProcess
    $procInfo = Get-CimInstance Win32_Process -Filter "ProcessId=$owner" -ErrorAction SilentlyContinue
    if ($procInfo -and $procInfo.CommandLine -like '*index.mjs*') {
        Warn "端口 $Port 上是旧的 Zeno 实例（PID $owner），停掉它"
        Stop-Process -Id $owner -Force -ErrorAction SilentlyContinue
        Start-Sleep -Seconds 1
        Ok '旧实例已停'
    } else {
        Die "端口 $Port 被 PID $owner 占用。换端口：.\deploy.ps1 -Port 9000"
    }
} else {
    Ok "端口 $Port 可用"
}

# ── 启动包装 ──────────────────────────────────────
# 计划任务默认不落 stdout，不包一层就没法看日志
$wrapper = Join-Path $InstallDir 'start-zeno.ps1'
# Task Scheduler 启动的 PowerShell 默认 cwd 是 C:\Windows\System32。
# server/index.mjs 的 DIST_DIR 与 DB_PATH 都是 resolve('./...')，相对 cwd ——
# 不钉死绝对路径的话，服务会在 System32 下建库并回 "dist not found"。
$wrapperContent = @"
`$ErrorActionPreference = 'Continue'
Set-Location -LiteralPath '$InstallDir'
`$env:PORT = $Port
`$env:DIST_DIR = '$InstallDir\dist'
`$env:DB_PATH = '$InstallDir\data\zeno.db'
& '$nodePath' '$InstallDir\server\index.mjs' *>> '$LogFile'
"@
Set-Content -Path $wrapper -Value $wrapperContent -Encoding UTF8
Ok ("启动包装已写入 " + $wrapper)

# ── 常驻 ──────────────────────────────────────────
if ($Mode -eq 'none') {
    Step '前台启动（Ctrl+C 退出）'
    $env:PORT = $Port
    node "$InstallDir\server\index.mjs"
    exit 0
}

Step '注册开机自启计划任务'

$action = New-ScheduledTaskAction -Execute 'powershell.exe' `
    -Argument "-NoProfile -WindowStyle Hidden -ExecutionPolicy Bypass -File `"$wrapper`""

$trigger = New-ScheduledTaskTrigger -AtStartup
$trigger.Delay = 'PT10S'

$settings = New-ScheduledTaskSettingsSet `
    -AllowStartIfOnBatteries `
    -DontStopIfGoingOnBatteries `
    -StartWhenAvailable `
    -RestartCount 999 `
    -RestartInterval (New-TimeSpan -Minutes 1) `
    -ExecutionTimeLimit ([TimeSpan]::Zero) `
    -MultipleInstances IgnoreNew

# 主体账号。SYSTEM 不需要登录、开机就在，行为等价于 systemd；
# 但它跑不起浏览器 —— 实测 Edge 在 SYSTEM / 会话 0 下 exitCode=1002 直接退出，
# 所以要用 fetch.mode="browser" 就得换成当前账号（S4U：仍是"不管是否登录都运行"，
# 且不把密码存进任务）。
if ($RunAsUser) {
    $acct = "$env:USERDOMAIN\$env:USERNAME"
    $principal = New-ScheduledTaskPrincipal -UserId $acct -LogonType S4U -RunLevel Highest
    Ok ("任务主体改用当前账号 $acct（S4U，不存密码）—— browser 渲染模式需要它")
} else {
    $principal = New-ScheduledTaskPrincipal -UserId 'NT AUTHORITY\SYSTEM' -LogonType ServiceAccount -RunLevel Highest
    Ok '任务主体为 SYSTEM（开机即在）'
    if ($browserFound) {
        # 本机有浏览器却用 SYSTEM，是最容易踩的组合：健康检查全绿，
        # 但插件里 fetch.mode="browser" 的那类（列表页要渲染的）一打开就 503。
        Warn '  SYSTEM / 会话 0 下起不了浏览器（Edge 直接 exitCode=1002）。'
        Warn '  用了 fetch.mode="browser" 的插件会报 503。常驻和渲染要兼得就重跑：'
        Warn '    .\deploy.ps1 -RunAsUser -SkipInstall'
    }
}

Register-ScheduledTask `
    -TaskName $ServiceName `
    -Action $action `
    -Trigger $trigger `
    -Settings $settings `
    -Principal $principal `
    -Force `
    -Description 'Zeno - clean web reader' | Out-Null

Ok '计划任务已注册（开机自启 + 崩溃自动重启）'

Stop-ScheduledTask -TaskName $ServiceName -ErrorAction SilentlyContinue
Start-Sleep -Seconds 1
Start-ScheduledTask -TaskName $ServiceName
Start-Sleep -Seconds 4

$task = Get-ScheduledTask -TaskName $ServiceName -ErrorAction SilentlyContinue
if ($task -and $task.State -eq 'Running') {
    Ok '服务已启动'
} else {
    Warn ("任务状态：" + $task.State)
    Warn ("看日志：Get-Content '" + $LogFile + "' -Tail 20")
}

# ── 健康检查 ──────────────────────────────────────
Step '健康检查'
$healthy = $false
for ($i = 0; $i -lt 6; $i++) {
    try {
        $r = Invoke-RestMethod "http://127.0.0.1:$Port/api/health" -TimeoutSec 3
        $healthy = $true
        Ok ("服务响应正常（插件 " + $r.plugins + " 个，白名单 " + $r.allowedHostsCount + " 个）")
        # 光看 /api/health 会漏判：它不依赖 dist。曾经有一次部署健康检查全绿，
        # 但因为 cwd 是 System32，站点根路径其实返回的是 "dist not found"。
        try {
            $page = Invoke-WebRequest "http://127.0.0.1:$Port/" -UseBasicParsing -TimeoutSec 5
            if ($page.Content -notmatch 'id="root"') { throw '响应里没有 #root' }
            Ok '首页 HTML 正常（dist 可读，工作目录正确）'
        } catch {
            Warn ("首页取不到：" + $_.Exception.Message)
            Warn ("服务的工作目录可能不对。它报告的数据库路径是 " + $r.dbPath)
            Warn ("应当落在 $InstallDir\data 下；落在 System32 说明 cwd 没设对。")
        }
        break
    } catch {
        Start-Sleep -Seconds 1
    }
}
if (-not $healthy) {
    Warn '服务没起来。日志：'
    if (Test-Path $LogFile) {
        Get-Content $LogFile -Tail 20 | ForEach-Object { Write-Host "    $_" -ForegroundColor DarkGray }
    } else {
        Write-Host '    （日志文件还没生成）' -ForegroundColor DarkGray
    }
}

# ── 插件仓库 ──────────────────────────────────────
# 主仓库不附带内容源，插件在独立仓库里维护；配了就把它们灌进服务端，
# 免得每次部署完还要人肉拷 JSON。拉不动只警告，不算部署失败。
Step '从插件仓库更新'
if (-not $env:ZENO_PLUGIN_REPO) {
    Warn '没配 ZENO_PLUGIN_REPO，跳过（网页里手动导入也行）'
    Warn '  自动拉私有库：$env:ZENO_PLUGIN_REPO = "账号/库名"; $env:ZENO_PLUGIN_TOKEN = "只读 PAT"'
} else {
    & $nodePath --import tsx (Join-Path $InstallDir 'scripts\pull-plugins.mjs')
    if ($LASTEXITCODE -ne 0) {
        Warn '插件没拉下来 —— 服务本身是好的，回头单独重跑：'
        Warn ("  node --import tsx '" + (Join-Path $InstallDir 'scripts\pull-plugins.mjs') + "'")
    }
}

# ── Tailscale ─────────────────────────────────────
if (-not $SkipTailscale) {
    . (Join-Path $InstallDir 'scripts\deploy-tailscale.ps1')
    Invoke-ZenoTailscale -Port $Port
}

# ── 汇总 ─────────────────────────────────────────
$lanAddr = '(本机IP)'
$allIps = Get-NetIPAddress -AddressFamily IPv4 -ErrorAction SilentlyContinue
if ($allIps) {
    $found = $allIps | Where-Object {
        $_.IPAddress -notlike '127.*' -and
        $_.IPAddress -notlike '169.254*' -and
        $_.InterfaceAlias -notmatch 'Loopback'
    } | Select-Object -First 1
    if ($found) { $lanAddr = $found.IPAddress }
}

Write-Host ''
Write-Host '部署完成' -ForegroundColor Green
Write-Host ''
Write-Host ("  本机      http://127.0.0.1:" + $Port)
Write-Host ("  局域网    http://" + $lanAddr + ":" + $Port)
Write-Host ("  数据目录  " + $InstallDir + "\data")
Write-Host ("  日志      " + $LogFile)
Write-Host ''
Write-Host '下一步：装插件' -ForegroundColor Cyan
Write-Host '  网页里进「设置 > 内容源插件 > 导入」，选一个 .json 插件文件。'
Write-Host '  装完白名单自动生效，不需要改任何配置。'
Write-Host ''
Write-Host '常用命令' -ForegroundColor Cyan
Write-Host ("  看日志    Get-Content '" + $LogFile + "' -Tail 20 -Wait")
Write-Host ("  重启      Restart-ScheduledTask -TaskName " + $ServiceName)
Write-Host ("  停止      Stop-ScheduledTask -TaskName " + $ServiceName)
Write-Host ("  看状态    Invoke-RestMethod http://127.0.0.1:" + $Port + "/api/health")
Write-Host ''

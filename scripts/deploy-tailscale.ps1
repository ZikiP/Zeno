<#
.SYNOPSIS
    配 Tailscale Serve 并诊断 HTTPS 可达性（deploy.ps1 的子模块）

.DESCRIPTION
    单独成文件是因为 deploy.ps1 已经管着装依赖、注册任务、健康检查好几件事。
    Step/Ok/Warn 这三个输出函数由调用方（deploy.ps1）定义，点源后同作用域可见。
#>
function Invoke-ZenoTailscale {
    param([int]$Port)

    if (-not (Get-Command tailscale -ErrorAction SilentlyContinue)) {
        Warn '没装 Tailscale，跳过 HTTPS 配置'
        return
    }

    Step '配置 Tailscale HTTPS'

    try {
        & tailscale serve --bg $Port 2>&1 | ForEach-Object { Write-Host "    $_" -ForegroundColor DarkGray }

        # 别用 ConvertFrom-Json 读 `tailscale status --json`：
        # 1.102 的 CapMap 里有重复键（"https" 出现两次），PS 5.1 直接抛
        # 「无效的应为 ’}’」，整段 HTTPS 地址和代理检测就都不输出了。
        # serve status 是纯文本，正则取第一个 ts.net 即可。
        $serveOut = (& tailscale serve status 2>&1) -join ' '
        $tsName = ''
        if ($serveOut -match 'https://([A-Za-z0-9._-]+\.ts\.net)') {
            $tsName = $Matches[1]
        }
        if (-not $tsName) { return }

        Ok ("HTTPS 地址：https://" + $tsName + "/")

        # 绕开系统代理直连，单独确认 serve 与证书本身没问题。
        # 必须用 curl.exe —— powershell 里 curl 是 Invoke-WebRequest 的别名。
        $probe = & curl.exe -s --noproxy '*' -o NUL -w '%{http_code}' `
            --max-time 15 ("https://" + $tsName + "/api/health") 2>$null
        if ($probe -eq '200') {
            Ok 'HTTPS 直连验证通过（证书有效）'
        } else {
            Warn ("HTTPS 直连验证未通过（HTTP " + $probe + "）。检查 tailnet 是否开启了证书签发。")
        }

        # 系统代理才是真坑：浏览器把 *.ts.net 塞进代理，TLS 握手被中断。
        # 而 Workbox 会用 precache 兜住导航，于是页面看着正常、请求全挂。
        # 代理状态在注册表里，清 $env:http_proxy 是空操作 —— 那个变量通常根本不存在。
        $ie = Get-ItemProperty `
            'HKCU:\Software\Microsoft\Windows\CurrentVersion\Internet Settings' `
            -ErrorAction SilentlyContinue
        if ($ie -and $ie.ProxyEnable -eq 1) {
            $hasBypass = $false
            foreach ($b in (@($ie.ProxyOverride -split ';'))) {
                if ($b -like '*ts.net*') { $hasBypass = $true }
            }
            Write-Host ''
            Write-Host ("  检测到系统代理：" + $ie.ProxyServer) -ForegroundColor Yellow
            if ($hasBypass) {
                Ok '代理的绕过列表已包含 *.ts.net'
            } else {
                Warn '绕过列表里没有 *.ts.net —— 浏览器会 ERR_CONNECTION_ABORTED，但页面看着像正常。'
                Warn '解法：在代理软件自己的「绕过 / 直连」设置里加 *.ts.net，不要直接改注册表。'
                Warn '  Clash 系客户端开关代理时会整个重写 ProxyOverride，手改会被静默覆盖。'
                Warn '也别指望 DOMAIN-SUFFIX,ts.net,DIRECT 这类规则：流量仍进代理，'
                Warn '  而 ts.net 只有 MagicDNS 能解析，代理解析不出来。'
            }
        }

        Write-Host ''
        Write-Host '  手机/平板怎么用：' -ForegroundColor Gray
        Write-Host '    1. 装 Tailscale 并登录同一账号' -ForegroundColor Gray
        Write-Host ("    2. 浏览器打开 https://" + $tsName + "/") -ForegroundColor Gray
        Write-Host '    3. 菜单「添加到主屏幕」即可当 App 用' -ForegroundColor Gray
        Write-Host '    4. 手机上也开着代理软件的话，同样要绕过 *.ts.net' -ForegroundColor Gray
    } catch {
        Warn ("Tailscale 配置失败：" + $_.Exception.Message)
    }
}

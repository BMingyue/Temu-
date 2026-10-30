$ErrorActionPreference = 'Stop'
$folder = Split-Path -Parent $MyInvocation.MyCommand.Path

Add-Type -AssemblyName PresentationFramework

try {
    $health = Invoke-RestMethod -Uri 'http://127.0.0.1:18769/api/health' -TimeoutSec 5
    if (-not $health.ok -or $health.service -ne 'temu-workbench') {
        throw '本机 18769 端口不是织品工作台服务。'
    }
    $probeOrigin = 'chrome-extension://' + ('a' * 32)
    $pairing = Invoke-RestMethod -Method Post -Uri 'http://127.0.0.1:18769/api/bridge/gpt/bootstrap' `
        -Headers @{ Origin = $probeOrigin } -ContentType 'application/json' `
        -Body '{"version":"0.3.40"}' -TimeoutSec 5
    if (-not $pairing.ok -or $pairing.extension_version -ne '0.3.40' -or [string]::IsNullOrWhiteSpace($pairing.token)) {
        throw '当前工作台不支持 GPT 生图助手 0.3.40 自动配对。'
    }
    $pairing = $null
} catch {
    [System.Windows.MessageBox]::Show(
        "没有检测到支持 0.3.40 的最新版织品工作台。`n`n请先安装或启动与本插件一起发布的最新版工作台，确认工作台页面可以打开，再重新双击本文件。`n`n$($_.Exception.Message)",
        'GPT 生图助手安装检查', 'OK', 'Error'
    ) | Out-Null
    exit 1
}

Start-Process explorer.exe -ArgumentList ('"' + $folder + '"')

$chromeCandidates = @(
    "$env:ProgramFiles\Google\Chrome\Application\chrome.exe",
    "${env:ProgramFiles(x86)}\Google\Chrome\Application\chrome.exe",
    "$env:LOCALAPPDATA\Google\Chrome\Application\chrome.exe"
)
$edgeCandidates = @(
    "${env:ProgramFiles(x86)}\Microsoft\Edge\Application\msedge.exe",
    "$env:ProgramFiles\Microsoft\Edge\Application\msedge.exe",
    "$env:LOCALAPPDATA\Microsoft\Edge\Application\msedge.exe"
)

$chrome = $chromeCandidates | Where-Object { Test-Path -LiteralPath $_ } | Select-Object -First 1
$edge = $edgeCandidates | Where-Object { Test-Path -LiteralPath $_ } | Select-Object -First 1
if ($chrome) { Start-Process -FilePath $chrome -ArgumentList 'chrome://extensions/' }
if ($edge) { Start-Process -FilePath $edge -ArgumentList 'edge://extensions/' }

$opened = @()
if ($chrome) { $opened += 'Chrome' }
if ($edge) { $opened += 'Edge' }
$browserText = if ($opened.Count) { '已打开：' + ($opened -join '、') + ' 扩展程序页面。' } else { '没有自动找到 Chrome 或 Edge，请手动打开浏览器扩展程序页面。' }

[System.Windows.MessageBox]::Show(
    "工作台连接检查通过。`n`n$browserText`n`n1. 已安装本扩展时，直接点击扩展卡片上的「重新加载」。`n2. 首次安装时开启开发者模式，点击「加载已解压的扩展程序」，选择已经打开的整个文件夹。`n3. 刷新 ChatGPT 页面。`n4. 点击扩展图标，确认显示 0.3.40 和「本地接口已连接」。",
    'GPT 生图助手 0.3.40', 'OK', 'Information'
) | Out-Null

